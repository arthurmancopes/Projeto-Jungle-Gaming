import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { config } from "../../src/infrastructure/config";
import { createSqsClient, resolveQueueUrl } from "../../src/infrastructure/sqs/sqs-client";
import { command, createHarness, expectConsistent, openWallet, sql, uuid, type Harness } from "../integration/harness";
import { AppInstance, waitFor } from "./instances";

/**
 * Três instâncias reais da aplicação (processos separados) sobre o mesmo PostgreSQL e o mesmo SQS.
 * Cobre: >= 3 instâncias simultâneas, instância morta no meio da carga, reinício do serviço
 * e a invariante final saldo == ledger para todas as wallets do banco.
 *
 * Requer: bun run infra:up && bun run migration:up. Não rode `bun run start` ao mesmo tempo.
 */
setDefaultTimeout(300_000);

let h: Harness;
let sqs: SQSClient;
let queueUrl: string;
const basePort = 41_000 + Math.floor(Math.random() * 1_000) * 3;
const instances = [0, 1, 2].map((i) => new AppInstance(`instance-${i + 1}`, basePort + i));
const RUN = `mi-${uuid()}`;

type Wallet = Awaited<ReturnType<typeof openWallet>>;

beforeAll(async () => {
  h = await createHarness();
  sqs = createSqsClient();
  queueUrl = await resolveQueueUrl(sqs, config.queues.wagerTransactions);
  await Promise.all(instances.map((instance) => instance.start()));
});

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.kill()));
  sqs?.destroy();
  await h?.close();
});

// ------------------------------------------------------------------ helpers

async function post(instance: AppInstance, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${instance.baseUrl}${path}`, {
    method: "POST",
    headers: { connection: "close", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function message(wallet: Wallet, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const base = command(wallet, kind, amount);
  return {
    messageId: `${RUN}-${uuid()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: base.providerId,
      externalTransactionId: base.externalTransactionId,
      idempotencyKey: base.idempotencyKey,
      playerId: base.playerId,
      walletId: base.walletId,
      roundId: base.roundId,
      gameId: base.gameId,
      kind,
      money: base.money,
      ...extra,
    },
  };
}

async function send(body: { messageId: string; data: { walletId: string } }): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: body.data.walletId,
      MessageDeduplicationId: uuid(), // cada envio é uma entrega distinta: duplicatas chegam de verdade
    }),
  );
}

async function processedCount(prefix: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    h,
    `select count(*)::int as n from inbox_messages
      where consumer_name = 'wager-transactions-consumer' and message_id like ? and processed_at is not null`,
    [`${prefix}%`],
  );
  return Number(row?.n ?? 0);
}

async function pendingOutbox(walletId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    h,
    `select count(*)::int as n from outbox_messages
      where published_at is null and payload->'data'->>'walletId' = ?`,
    [walletId],
  );
  return Number(row?.n ?? 0);
}

async function distribution(prefix: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const instance of instances) {
    result[instance.name] = (await instance.processedMessageIds(prefix)).length;
  }
  return result;
}

const allWallets: Wallet[] = [];
async function wallet(amount: string): Promise<Wallet> {
  const created = await openWallet(h, amount);
  allWallets.push(created);
  return created;
}

// ------------------------------------------------------------------- tests

describe("Três instâncias simultâneas", () => {
  test("HTTP distribuído entre as instâncias: sem débito duplicado, sem saldo negativo", async () => {
    const target = await wallet("200.00");

    // 60 apostas distintas de 10.00 + a mesma aposta repetida 30 vezes, espalhadas pelas 3 instâncias.
    const distinct = Array.from({ length: 60 }, () => command(target, "BET", "10.00"));
    const repeated = command(target, "BET", "10.00");
    const requests = [...distinct, ...Array.from({ length: 30 }, () => repeated)];

    const responses = await Promise.all(
      requests.map((cmd, i) => {
        const { correlationId: _c, inbox: _i, idempotencyKey, ...body } = cmd;
        return post(instances[i % instances.length] as AppInstance, "/wagering/transactions", body, {
          "Idempotency-Key": idempotencyKey,
        });
      }),
    );

    // Nenhuma falha de infraestrutura: só 201, 200 (replay) e 422 (sem saldo).
    expect(responses.every((r) => [200, 201, 422].includes(r.status))).toBe(true);

    const snap = await expectConsistent(h, target.id);
    expect(snap.balance).toBe("0.00"); // 200.00 / 10.00 = exatamente 20 débitos
    expect(snap.debits).toBe(20);

    const rows = await sql(h, `select id from wager_transactions where idempotency_key = ?`, [repeated.idempotencyKey]);
    expect(rows).toHaveLength(1);
    const repeatedIds = new Set(
      responses.slice(60).map((r) => (r.body.transactionId as string | undefined) ?? "none"),
    );
    expect(repeatedIds.size).toBe(1); // as 30 cópias devolveram a mesma transação
  });

  test("SQS: as três instâncias consomem a mesma fila, com mensagens duplicadas", async () => {
    const prefix = `${RUN}-sqs`;
    const wallets = await Promise.all(Array.from({ length: 10 }, () => wallet("100.00")));
    const messages = wallets.flatMap((w) =>
      Array.from({ length: 10 }, () => ({ ...message(w, "BET", "5.00"), messageId: `${prefix}-${uuid()}` })),
    );

    // Cada mensagem é entregue duas vezes.
    await Promise.all([...messages, ...messages].map((m) => send(m)));
    await waitFor("all messages processed", async () => (await processedCount(prefix)) === messages.length);

    for (const w of wallets) {
      const snap = await expectConsistent(h, w.id);
      expect(snap.balance).toBe("50.00");
      expect(snap.debits).toBe(10);
    }
    console.log("mensagens processadas por instância:", await distribution(prefix));
  });

  test("outbox: os publishers das três instâncias publicam todos os eventos", async () => {
    // Inclui o backlog deixado por outros testes: pode levar alguns segundos.
    await waitFor(
      "outbox drained for this run",
      async () => {
        for (const w of allWallets) if ((await pendingOutbox(w.id)) > 0) return false;
        return true;
      },
      240_000,
      1_000,
    );
  });
});

describe("Falhas e recuperação", () => {
  test("instância morta (SIGKILL) no meio da carga: outra assume, nenhum efeito perdido ou duplicado", async () => {
    const prefix = `${RUN}-kill`;
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet("100.00")));
    const messages = wallets.flatMap((w) =>
      Array.from({ length: 20 }, () => ({ ...message(w, "BET", "1.00"), messageId: `${prefix}-${uuid()}` })),
    );
    await Promise.all(messages.map((m) => send(m)));

    // Mata a instância 1 com trabalho em andamento e sobe uma substituta.
    await waitFor("some messages processed", async () => (await processedCount(prefix)) >= 10, 60_000, 50);
    const victim = instances[0] as AppInstance;
    await victim.kill();
    await victim.start();

    // Mensagens que estavam com a instância morta voltam após o visibility timeout (5s aqui).
    await waitFor("all messages processed after crash", async () => (await processedCount(prefix)) === messages.length);
    for (const w of wallets) {
      const snap = await expectConsistent(h, w.id);
      expect(snap.balance).toBe("80.00");
      expect(snap.debits).toBe(20);
    }
  });

  test.skipIf(process.platform === "win32")(
    "SIGTERM: desligamento gracioso conclui o trabalho em andamento e sai com código 0",
    async () => {
      // No Windows não há SIGTERM real: o processo é encerrado à força (coberto pelo teste acima).
      const prefix = `${RUN}-term`;
      const target = await wallet("100.00");
      const messages = Array.from({ length: 20 }, () => ({
        ...message(target, "BET", "1.00"),
        messageId: `${prefix}-${uuid()}`,
      }));
      await Promise.all(messages.map((m) => send(m)));

      const instance = instances[1] as AppInstance;
      await waitFor("some messages processed", async () => (await processedCount(prefix)) >= 1, 60_000, 50);
      expect(await instance.terminate()).toBe(0);
      await instance.start();

      await waitFor("all processed after graceful shutdown", async () => (await processedCount(prefix)) === 20);
      expect(await expectConsistent(h, target.id)).toMatchObject({ balance: "80.00", debits: 20 });
    },
  );

  test("reinício completo do serviço: pendências retomadas e consistência final comprovada", async () => {
    // Uma reversão aguardando referência e mensagens na fila no momento da queda.
    const target = await wallet("100.00");
    const bet = command(target, "BET", "40.00");
    const refund = await h.submit.execute(
      command(target, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(String(refund.status)).toBe("PENDING_REFERENCE");

    const prefix = `${RUN}-restart`;
    const queued = Array.from({ length: 10 }, () => ({
      ...message(target, "WIN", "2.00"),
      messageId: `${prefix}-${uuid()}`,
    }));

    // Derruba tudo à força, com a referência chegando e mensagens enfileiradas.
    await Promise.all(instances.map((instance) => instance.kill()));
    await h.submit.execute(bet);
    await Promise.all(queued.map((m) => send(m)));

    // Serviço volta.
    await Promise.all(instances.map((instance) => instance.start()));

    await waitFor("queued messages processed after restart", async () => (await processedCount(prefix)) === 10);
    await waitFor("pending refund resolved after restart", async () => {
      const [row] = await sql<{ status: string }>(h, `select status from wager_transactions where id = ?`, [
        refund.transactionId,
      ]);
      return row?.status === "PROCESSED";
    });
    expect(await expectConsistent(h, target.id)).toMatchObject({ balance: "120.00", debits: 1, credits: 12 });

    // Reconciliação via API, em uma instância qualquer, para todas as wallets deste arquivo.
    for (const [i, w] of allWallets.entries()) {
      const response = await post(instances[i % instances.length] as AppInstance, `/wallets/${w.id}/reconciliation`, {});
      expect(response.status).toBe(200);
      expect(response.body.consistent).toBe(true);
    }

    // Invariante final para o banco inteiro (inclui tudo que os outros testes já gravaram).
    const [global] = await sql<{ inconsistent: number; wallets: number }>(
      h,
      `select count(*) filter (where w.balance <> coalesce(l.total, 0))::int as inconsistent,
              count(*)::int as wallets
         from wallets w
         left join (
           select wallet_id, sum(case direction when 'CREDIT' then amount else -amount end) as total
             from wallet_ledger_entries
            group by wallet_id
         ) l on l.wallet_id = w.id`,
    );
    expect(global?.inconsistent).toBe(0);
    console.log(`invariante final: ${global?.wallets} wallets verificadas, 0 inconsistentes`);
  });
});
