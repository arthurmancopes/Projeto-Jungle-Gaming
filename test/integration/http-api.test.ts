import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../src/app";

/**
 * Testes ponta a ponta da API: aplicação NestJS real, PostgreSQL e LocalStack reais.
 * Requer: bun run infra:up && bun run migration:up
 */
setDefaultTimeout(30_000);

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await createApp({ logger: false, workers: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await app.close();
});

const uuid = () => Bun.randomUUIDv7();

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    // "connection: close" evita sockets keep-alive ociosos, que atrasariam o app.close() no final.
    headers: { connection: "close", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
}

async function createWallet(amount: string) {
  const response = await call("POST", "/wallets", {
    playerId: uuid(),
    initialBalance: { amount, currency: "BRL" },
  });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string; balance: { amount: string }; version: number };
}

function transaction(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: object = {}) {
  const externalTransactionId = `tx-${uuid()}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: "provider-a",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
      ...extra,
    },
  };
}

const submit = (tx: { key: string; body: object }) =>
  call("POST", "/wagering/transactions", tx.body, { "Idempotency-Key": tx.key });

describe("Wallets", () => {
  test("POST /wallets cria com version 1; duplicada é 409", async () => {
    const playerId = uuid();
    const payload = { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } };

    const created = await call("POST", "/wallets", payload);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });

    const duplicate = await call("POST", "/wallets", payload);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("POST /wallets com amount numérico (não string) é 400", async () => {
    const response = await call("POST", "/wallets", { playerId: uuid(), initialBalance: { amount: 10, currency: "BRL" } });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_MONEY");
  });

  test("GET /wallets/:id devolve a wallet; inexistente é 404", async () => {
    const wallet = await createWallet("50.00");
    const found = await call("GET", `/wallets/${wallet.id}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: { amount: "50.00", currency: "BRL" }, version: 1 });

    expect((await call("GET", `/wallets/${uuid()}`)).status).toBe(404);
    expect((await call("GET", `/wallets/nao-e-uuid`)).status).toBe(404);
  });
});

describe("POST /wagering/transactions — status HTTP distintos por situação", () => {
  test("201 processada, 200 replay idêntico, 409 mesma key com payload diferente", async () => {
    const wallet = await createWallet("1000.00");
    const bet = transaction(wallet, "BET", "25.00");

    const first = await submit(bet);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });

    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await submit({ key: bet.key, body: { ...bet.body, money: { amount: "26.00", currency: "BRL" } } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");

    expect((await call("GET", `/wallets/${wallet.id}`)).body.balance.amount).toBe("975.00");
  });

  test("422 rejeição de negócio com failureCode (e o replay devolve o mesmo 422)", async () => {
    const wallet = await createWallet("10.00");
    const bet = transaction(wallet, "BET", "10.01");

    const rejected = await submit(bet);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({
      code: "INSUFFICIENT_FUNDS",
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00", currency: "BRL" },
    });

    const replay = await submit(bet);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("202 aceite pendente quando a referência ainda não chegou", async () => {
    const wallet = await createWallet("10.00");
    const refund = transaction(wallet, "REFUND", "5.00", { referenceExternalTransactionId: `bet-${uuid()}` });
    const response = await submit(refund);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe("PENDING_REFERENCE");
  });

  test("400 payload inválido: header ausente, kind inválido, OPENING, JSON malformado", async () => {
    const wallet = await createWallet("10.00");
    const bet = transaction(wallet, "BET", "1.00");

    const noHeader = await call("POST", "/wagering/transactions", bet.body);
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.code).toBe("INVALID_PAYLOAD");

    expect((await submit({ ...bet, body: { ...bet.body, kind: "JACKPOT" } })).status).toBe(400);
    expect((await submit({ ...bet, body: { ...bet.body, kind: "OPENING" } })).status).toBe(400);
    expect((await submit({ ...bet, body: { ...bet.body, money: { amount: "1.999", currency: "BRL" } } })).status).toBe(400);

    const malformed = await call("POST", "/wagering/transactions", "{not json", {
      "Idempotency-Key": bet.key,
      "content-type": "application/json",
    });
    expect(malformed.status).toBe(400);
  });

  test("404 wallet inexistente", async () => {
    const response = await submit(transaction({ id: uuid(), playerId: uuid() }, "BET", "1.00"));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("WALLET_NOT_FOUND");
  });

  test("X-Correlation-Id é devolvido na resposta e no corpo de erro", async () => {
    const response = await call("GET", `/wallets/${uuid()}`, undefined, { "X-Correlation-Id": "corr-abc-123" });
    expect(response.headers.get("x-correlation-id")).toBe("corr-abc-123");
    expect(response.body.correlationId).toBe("corr-abc-123");
  });
});

describe("Consultas", () => {
  test("transação por id interno e por (providerId, externalTransactionId)", async () => {
    const wallet = await createWallet("100.00");
    const bet = transaction(wallet, "BET", "40.00");
    const submitted = await submit(bet);

    const byId = await call("GET", `/wagering/transactions/${submitted.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: submitted.body.transactionId,
      kind: "BET",
      status: "PROCESSED",
      money: { amount: "40.00", currency: "BRL" },
      balance: { amount: "60.00", currency: "BRL" },
    });

    const byExternal = await call(
      "GET",
      `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);

    expect((await call("GET", `/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect((await call("GET", `/providers/provider-a/wagering/transactions/nao-existe`)).status).toBe(404);
  });

  test("ledger paginado por cursor opaco e estável", async () => {
    const wallet = await createWallet("100.00");
    for (const amount of ["1.00", "2.00", "3.00", "4.00"]) {
      await submit(transaction(wallet, "BET", amount));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const page = await call("GET", `/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((item: { money: { amount: string } }) => item.money.amount));
      cursor = page.body.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);

    // Abertura (100.00) + 4 apostas, na ordem em que foram lançadas, sem repetição nem lacuna.
    expect(seen).toEqual(["100.00", "1.00", "2.00", "3.00", "4.00"]);
    expect(pages).toBe(3);

    expect((await call("GET", `/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await call("GET", `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
    expect((await call("GET", `/wallets/${uuid()}/ledger`)).status).toBe(404);
  });

  test("reconciliação: saldo materializado == saldo do ledger", async () => {
    const wallet = await createWallet("1000.00");
    await submit(transaction(wallet, "BET", "25.00"));
    await submit(transaction(wallet, "LOSS", "25.00"));

    const response = await call("POST", `/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });

    expect((await call("POST", `/wallets/${uuid()}/reconciliation`)).status).toBe(404);
  });
});

/** Soma os valores das séries de uma métrica que contêm todos os rótulos pedidos. */
function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .filter((line) => Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`)))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

describe("Métricas", () => {
  test("GET /metrics expõe transações por status, duplicatas, latência, outbox e DLQ", async () => {
    const before = await (await fetch(`${baseUrl}/metrics`, { headers: { connection: "close" } })).text();

    const wallet = await createWallet("100.00");
    const bet = transaction(wallet, "BET", "10.00");
    await submit(bet);
    await submit(bet); // replay
    await submit(transaction(wallet, "BET", "500.00")); // rejeitada

    const response = await fetch(`${baseUrl}/metrics`, { headers: { connection: "close" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const after = await response.text();

    const delta = (name: string, labels: Record<string, string>) =>
      metricValue(after, name, labels) - metricValue(before, name, labels);

    expect(delta("wager_transactions_total", { source: "http", kind: "BET", status: "PROCESSED" })).toBe(1);
    expect(
      delta("wager_transactions_total", { source: "http", status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" }),
    ).toBe(1);
    expect(delta("wager_duplicates_total", { source: "http", reason: "idempotency_key" })).toBe(1);
    expect(delta("wager_processing_duration_seconds_count", { source: "http" })).toBe(3);

    for (const name of [
      "wager_retries_total",
      "wager_dlq_messages_total",
      "wallet_lock_conflicts_total",
      "wallet_reconciliation_mismatch_total",
      "outbox_lag_seconds",
      "outbox_pending_messages",
      "sqs_dlq_messages",
    ]) {
      expect(after).toContain(`# TYPE ${name} `);
    }
    expect(metricValue(after, "outbox_pending_messages")).toBeGreaterThan(0); // sem workers, nada é publicado
    expect(metricValue(after, "outbox_lag_seconds")).toBeGreaterThan(0);
  });
});

describe("Health", () => {
  test("GET /health/live responde sem tocar em dependências", async () => {
    const response = await call("GET", "/health/live");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  test("GET /health/ready verifica PostgreSQL e SQS", async () => {
    const response = await call("GET", "/health/ready");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
  });
});
