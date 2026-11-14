import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { TransientInfrastructureError } from "../../src/application/errors";
import type { EventPublisher } from "../../src/application/ports/event-publisher";
import type { Clock } from "../../src/application/ports/system";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work";
import { PublishOutboxUseCase } from "../../src/application/publish-outbox.use-case";
import { RetryPendingReferencesUseCase } from "../../src/application/retry-pending-references.use-case";
import type { SubmitWagerTransactionUseCase } from "../../src/application/submit-wager-transaction.use-case";
import { WagerProcessor } from "../../src/application/wager-processor";
import type { OutboxMessage } from "../../src/domain/outbox-message";
import { config } from "../../src/infrastructure/config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { createSqsClient, resolveQueueUrl } from "../../src/infrastructure/sqs/sqs-client";
import { SqsEventPublisher } from "../../src/infrastructure/sqs/sqs-event-publisher";
import { WagerQueueConsumer } from "../../src/infrastructure/sqs/wager-queue-consumer";
import { UuidV7Generator } from "../../src/infrastructure/system";
import { command, createHarness, expectConsistent, openWallet, sql, uuid, type Harness } from "./harness";

/**
 * Mensageria contra PostgreSQL e LocalStack reais (bun run infra:up && bun run migration:up).
 * Não rode a aplicação (bun run start) ao mesmo tempo: ela consumiria as mesmas filas.
 */
setDefaultTimeout(180_000);

let h: Harness;
let sqs: SQSClient;
let queueUrl: string;
let dlqUrl: string;
let eventsUrl: string;

beforeAll(async () => {
  h = await createHarness();
  sqs = createSqsClient();
  [queueUrl, dlqUrl, eventsUrl] = await Promise.all([
    resolveQueueUrl(sqs, config.queues.wagerTransactions),
    resolveQueueUrl(sqs, config.queues.wagerTransactionsDlq),
    resolveQueueUrl(sqs, config.queues.events),
  ]);
  await Promise.all([queueUrl, dlqUrl, eventsUrl].map((url) => sqs.send(new PurgeQueueCommand({ QueueUrl: url }))));
  await assertNoForeignConsumer();
});

/**
 * Estes testes precisam ser os únicos leitores da fila. Se uma instância da aplicação
 * estiver rodando (bun run start, ou um processo que sobrou de outro teste), ela consome
 * as mensagens dos testes e as falhas ficam confusas. Aqui a situação é detectada e explicada.
 */
async function assertNoForeignConsumer(): Promise<void> {
  const probeId = `probe-${uuid()}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ probe: probeId }),
      MessageGroupId: probeId,
      MessageDeduplicationId: probeId,
    }),
  );
  // Folga para long polls abandonados por processos mortos em testes anteriores expirarem.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
    );
    for (const message of Messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      if (message.Body?.includes(probeId)) return;
    }
  }
  // Uma instância da aplicação que pegou a mensagem a descarta na DLQ como contrato inválido.
  const inDlq = (await drain(dlqUrl)).some((body) => body.includes(probeId));
  throw new Error(
    "Outro processo está consumindo a fila wager-transactions.fifo (a mensagem de verificação não chegou ao teste" +
      (inDlq ? "; ela foi parar na DLQ, ou seja, uma instância da aplicação a recebeu). " : "). ") +
      "Encerre qualquer `bun run start` aberto e processos bun que tenham sobrado " +
      "(PowerShell: Get-Process bun) e rode os testes de novo.",
  );
}
afterAll(async () => {
  sqs.destroy();
  await h.close();
});

// ------------------------------------------------------------------ helpers

class FakeClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Wallet = Awaited<ReturnType<typeof openWallet>>;

function envelope(wallet: Wallet, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const base = command(wallet, kind, amount);
  return {
    messageId: `msg-${uuid()}`,
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

async function send(body: unknown, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(), // cada envio é uma entrega distinta para o broker
    }),
  );
}

/** Lê e remove o que houver na fila, devolvendo os corpos. */
async function drain(url: string): Promise<string[]> {
  const bodies: string[] = [];
  for (let i = 0; i < 20; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (Messages.length === 0) break;
    for (const message of Messages) {
      bodies.push(message.Body ?? "");
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return bodies;
}

function consumer(
  options: {
    client?: SQSClient;
    submit?: SubmitWagerTransactionUseCase;
    visibilityTimeoutSeconds?: number;
    retryDelaySeconds?: (receiveCount: number) => number;
  } = {},
): WagerQueueConsumer {
  return new WagerQueueConsumer(options.client ?? sqs, options.submit ?? h.submit, {
    queueUrl,
    dlqUrl,
    waitTimeSeconds: 1,
    ...(options.visibilityTimeoutSeconds !== undefined
      ? { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds }
      : {}),
    ...(options.retryDelaySeconds ? { retryDelaySeconds: options.retryDelaySeconds } : {}),
  });
}

/** Cliente SQS real que falha uma única vez no comando indicado (simula queda do processo). */
function failingOnce(client: SQSClient, commandName: string): SQSClient {
  let failed = false;
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "send") return Reflect.get(target, property, receiver);
      return (cmd: object, ...rest: unknown[]) => {
        if (!failed && cmd.constructor.name === commandName) {
          failed = true;
          return Promise.reject(new Error(`simulated crash before ${commandName}`));
        }
        return (target.send as (...args: unknown[]) => unknown).apply(target, [cmd, ...rest]);
      };
    },
  });
}

/** Publisher real (SQS) que conta quantas vezes cada evento foi publicado. */
class CountingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    readonly counts: Map<string, number>,
    private readonly failFirstFor: Set<string> = new Set(),
  ) {}
  async publish(message: OutboxMessage): Promise<void> {
    if (this.failFirstFor.delete(message.id)) {
      throw new Error("simulated broker failure");
    }
    await this.inner.publish(message);
    this.counts.set(message.id, (this.counts.get(message.id) ?? 0) + 1);
  }
}

const outboxOf = (walletId: string) =>
  sql<{ id: string; event_type: string; attempts: number; published: boolean }>(
    h,
    `select o.id, o.event_type, o.attempts, (o.published_at is not null) as published
       from outbox_messages o
      where o.payload->'data'->>'walletId' = ?
      order by o.occurred_at, o.id`,
    [walletId],
  );

async function publishUntilEmpty(useCase: PublishOutboxUseCase): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const result = await useCase.execute();
    if (result.claimed === 0) return;
  }
  throw new Error("outbox did not drain");
}

// ------------------------------------------------------------ SQS consumer

describe("Consumidor SQS", () => {
  test("processa a mensagem pelo mesmo caso de uso e só confirma depois do commit", async () => {
    const wallet = await openWallet(h, "100.00");
    const message = envelope(wallet, "BET", "30.00");
    await send(message, wallet.id);

    expect(await consumer().pollOnce()).toEqual(["acked"]);

    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "70.00", debits: 1 });
    const [inbox] = await sql<{ processed: boolean }>(
      h,
      `select (processed_at is not null) as processed from inbox_messages where message_id = ?`,
      [message.messageId],
    );
    expect(inbox?.processed).toBe(true);
    expect(await consumer().pollOnce()).toEqual([]); // fila vazia: a mensagem foi removida
  });

  test("redelivery da mesma mensagem não duplica o efeito (inbox)", async () => {
    const wallet = await openWallet(h, "100.00");
    const message = envelope(wallet, "BET", "30.00");
    await send(message, wallet.id);
    await send(message, wallet.id); // mesma messageId entregue de novo pelo broker

    const outcomes = [...(await consumer().pollOnce()), ...(await consumer().pollOnce())];
    expect(outcomes).toEqual(["acked", "acked"]);
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "70.00", debits: 1 });
  });

  test("worker morto depois do commit e antes do ack: a reentrega vira replay", async () => {
    const wallet = await openWallet(h, "100.00");
    await send(envelope(wallet, "BET", "30.00"), wallet.id);

    // 1ª instância: commit feito, mas o DeleteMessage (ack) falha — como se o processo morresse.
    const dying = consumer({ client: failingOnce(sqs, "DeleteMessageCommand"), visibilityTimeoutSeconds: 1 });
    expect(await dying.pollOnce()).toEqual(["retry"]);
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "70.00", debits: 1 });

    // A visibilidade expira e outra instância recebe a mesma mensagem.
    await sleep(1500);
    expect(await consumer().pollOnce()).toEqual(["acked"]);
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "70.00", debits: 1 });
  });

  test("rejeição de negócio é terminal: transação REJECTED gravada e mensagem confirmada", async () => {
    const wallet = await openWallet(h, "10.00");
    const message = envelope(wallet, "BET", "30.00");
    await send(message, wallet.id);

    expect(await consumer().pollOnce()).toEqual(["acked"]);
    const [tx] = await sql<{ status: string; failure_code: string }>(
      h,
      `select status, failure_code from wager_transactions where idempotency_key = ?`,
      [message.data.idempotencyKey],
    );
    expect(tx).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await drain(dlqUrl)).toEqual([]);
  });

  test("erro permanente vai direto para a DLQ: contrato inválido e conflito de idempotência", async () => {
    const wallet = await openWallet(h, "100.00");
    const original = envelope(wallet, "BET", "10.00");
    const conflicting = {
      ...original,
      messageId: `msg-${uuid()}`,
      data: { ...original.data, money: { amount: "99.00", currency: "BRL" } },
    };
    const numericAmount = envelope(wallet, "BET", "5.00", { money: { amount: 5, currency: "BRL" } });

    await send(original, wallet.id);
    await send(conflicting, wallet.id);
    await send("{isto não é json", `g-${uuid()}`);
    await send(numericAmount, `g-${uuid()}`);

    const outcomes: string[] = [];
    for (let i = 0; i < 6 && outcomes.length < 4; i++) outcomes.push(...(await consumer().pollOnce()));
    expect(outcomes.sort()).toEqual(["acked", "dead-lettered", "dead-lettered", "dead-lettered"]);

    const dead = await drain(dlqUrl);
    expect(dead).toHaveLength(3);
    expect(dead).toContain("{isto não é json");
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "90.00", debits: 1 });
  });

  test("falha transitória: retry sem ack e, esgotadas as tentativas, DLQ pela redrive policy", async () => {
    const wallet = await openWallet(h, "100.00");
    const message = envelope(wallet, "BET", "30.00");
    await send(message, wallet.id);

    // Banco "indisponível" para este consumidor; a fila e a redrive policy são reais.
    const unavailable = {
      execute: () => Promise.reject(new TransientInfrastructureError("database temporarily unavailable")),
    } as unknown as SubmitWagerTransactionUseCase;
    const failing = consumer({ submit: unavailable, retryDelaySeconds: () => 0 });

    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const polled = await failing.pollOnce();
      if (polled.length === 0) break;
      outcomes.push(...polled);
    }
    // maxReceiveCount = 5: depois disso o broker move a mensagem para a DLQ por conta própria.
    expect(outcomes.length).toBeGreaterThanOrEqual(4);
    expect(outcomes.length).toBeLessThanOrEqual(6);
    expect(outcomes.every((outcome) => outcome === "retry")).toBe(true);

    const dead = await drain(dlqUrl);
    expect(dead.map((body) => JSON.parse(body).messageId)).toEqual([message.messageId]);
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "100.00", debits: 0 });
  });

  test("shutdown devolve à fila as mensagens que não chegaram a ser processadas", async () => {
    const wallet = await openWallet(h, "100.00");
    await send(envelope(wallet, "BET", "1.00"), wallet.id);

    const stopping = consumer({ visibilityTimeoutSeconds: 2 });
    stopping.start();
    await stopping.stop(); // interrompe o long polling e libera o que estiver pendente

    // Nada se perde: ou o consumidor parado concluiu a mensagem antes de sair, ou ela volta
    // para a fila (devolvida no shutdown, ou no pior caso ao expirar a visibilidade de 2s).
    for (let i = 0; i < 5; i++) {
      await consumer().pollOnce();
      if ((await expectConsistent(h, wallet.id)).debits === 1) break;
      await sleep(1000);
    }
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "99.00", debits: 1 });
  });
});

// ----------------------------------------------------- transactional outbox

describe("Transactional outbox", () => {
  const publisherFor = (counts: Map<string, number>, clock: Clock, uow?: UnitOfWork, failFirstFor?: Set<string>) =>
    new PublishOutboxUseCase(
      uow ?? new MikroOrmUnitOfWork(h.orm),
      new CountingPublisher(new SqsEventPublisher(sqs, eventsUrl), counts, failFirstFor),
      clock,
    );

  test("dois publishers concorrentes sobre a mesma outbox: cada evento é publicado uma única vez", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(h, "100.00")));
    await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 4 }, () => h.submit.execute(command(wallet, "BET", "5.00")))),
    );

    const counts = new Map<string, number>();
    const clock = new FakeClock();
    clock.advance(600_000); // inclui eventuais mensagens antigas com retry agendado
    await Promise.all([
      publishUntilEmpty(publisherFor(counts, clock)),
      publishUntilEmpty(publisherFor(counts, clock)),
    ]);

    for (const wallet of wallets) {
      const rows = await outboxOf(wallet.id);
      // Abertura (2 eventos) + 4 apostas x 2 eventos.
      expect(rows).toHaveLength(10);
      expect(rows.every((row) => row.published)).toBe(true);
      expect(rows.map((row) => counts.get(row.id))).toEqual(rows.map(() => 1));
    }

    const delivered = (await drain(eventsUrl)).map((body) => JSON.parse(body));
    const sample = delivered.find((event) => event.eventType === "WalletBalanceChanged");
    expect(sample).toMatchObject({ version: 1, data: { money: { currency: "BRL" } } });
    expect(typeof sample.data.money.amount).toBe("string");
  });

  test("commit confirmado, processo morre antes de publicar: outra instância publica", async () => {
    const wallet = await openWallet(h, "100.00");
    await h.submit.execute(command(wallet, "BET", "5.00"));
    // Os eventos já estão commitados na outbox, e nada foi publicado ainda.
    expect((await outboxOf(wallet.id)).every((row) => !row.published)).toBe(true);

    // Instância A publica no broker, mas morre antes do commit que marcaria published_at.
    const counts = new Map<string, number>();
    const clock = new FakeClock();
    const real = new MikroOrmUnitOfWork(h.orm);
    const crashing: UnitOfWork = {
      run: (work) =>
        real.run(async (ctx) => {
          await work(ctx);
          throw new Error("simulated crash before commit");
        }),
    };
    await expect(publisherFor(counts, clock, crashing).execute()).rejects.toThrow("simulated crash");
    expect((await outboxOf(wallet.id)).every((row) => !row.published)).toBe(true);

    // Instância B assume: nada se perde. A republicação é segura (mesmo eventId).
    await publishUntilEmpty(publisherFor(counts, clock));
    const rows = await outboxOf(wallet.id);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.published)).toBe(true);
    expect(rows.every((row) => (counts.get(row.id) ?? 0) >= 1)).toBe(true);
    await drain(eventsUrl);
  });

  test("falha do broker: evento não é marcado, retry com backoff e publicação posterior", async () => {
    const wallet = await openWallet(h, "0.00");
    await h.submit.execute(command(wallet, "WIN", "5.00"));
    const [first] = await outboxOf(wallet.id);
    if (!first) throw new Error("expected outbox rows");

    const counts = new Map<string, number>();
    const clock = new FakeClock();
    await publishUntilEmpty(publisherFor(counts, clock, undefined, new Set([first.id])));

    const afterFailure = (await outboxOf(wallet.id)).find((row) => row.id === first.id);
    expect(afterFailure).toMatchObject({ published: false, attempts: 1 });
    expect(counts.has(first.id)).toBe(false);

    clock.advance(5_000); // passa do backoff de 2s
    await publishUntilEmpty(publisherFor(counts, clock));
    const afterRetry = (await outboxOf(wallet.id)).find((row) => row.id === first.id);
    expect(afterRetry).toMatchObject({ published: true, attempts: 1 });
    expect(counts.get(first.id)).toBe(1);
    await drain(eventsUrl);
  });
});

// --------------------------------------------------- referências pendentes

describe("Referências fora de ordem (worker de reprocessamento)", () => {
  const retrier = (clock: Clock) =>
    new RetryPendingReferencesUseCase(
      new MikroOrmUnitOfWork(h.orm),
      new WagerProcessor(new UuidV7Generator(), clock),
      clock,
    );

  const statusOf = async (transactionId: string) => {
    const [row] = await sql<{ status: string; failure_code: string | null; reference_attempts: number }>(
      h,
      `select status, failure_code, reference_attempts from wager_transactions where id = ?`,
      [transactionId],
    );
    if (!row) throw new Error("transaction not found");
    return row;
  };

  test("REFUND entregue antes da BET é aplicado quando a referência chega", async () => {
    const wallet = await openWallet(h, "100.00");
    const bet = command(wallet, "BET", "40.00");
    const refund = await h.submit.execute(
      command(wallet, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(String(refund.status)).toBe("PENDING_REFERENCE");

    await h.submit.execute(bet);
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "60.00" });

    // Dois workers ao mesmo tempo: SKIP LOCKED garante um único crédito.
    const clock = new FakeClock();
    clock.advance(5_000);
    for (let i = 0; i < 5; i++) {
      await Promise.all([retrier(clock).execute(), retrier(clock).execute()]);
      if ((await statusOf(refund.transactionId)).status !== "PENDING_REFERENCE") break;
    }

    expect(await statusOf(refund.transactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "100.00", debits: 1, credits: 2 });
  });

  test("referência que nunca chega: REJECTED com REFERENCE_NOT_FOUND após o limite, com evento", async () => {
    const wallet = await openWallet(h, "100.00");
    const rollback = await h.submit.execute(
      command(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: `nunca-${uuid()}` }),
    );

    const clock = new FakeClock();
    let state = await statusOf(rollback.transactionId);
    for (let i = 0; i < 40 && state.status === "PENDING_REFERENCE"; i++) {
      clock.advance(61_000); // maior que o teto do backoff
      await retrier(clock).execute();
      state = await statusOf(rollback.transactionId);
    }

    expect(state).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "100.00", version: 1 });

    const events = await sql<{ event_type: string }>(
      h,
      `select event_type from outbox_messages where payload->>'causationId' = ? order by occurred_at, event_type`,
      [rollback.transactionId],
    );
    expect(events.map((event) => event.event_type).sort()).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
  });
});
