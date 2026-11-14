/**
 * Teste de carga — bun run test:load
 *
 * Sobe N instâncias reais da aplicação (processos separados) sobre o PostgreSQL e o LocalStack
 * do Docker Compose, executa os cenários abaixo e grava um relatório em load-test-results/.
 *
 *   1. HTTP, wallets distribuídas: carga mista (BET, WIN, LOSS e replays) espalhada por muitas wallets.
 *   2. HTTP, wallet quente: todos os clientes disputando a mesma wallet (pior caso do lock pessimista).
 *   3. SQS: lote de mensagens enfileirado de uma vez, consumido pelas N instâncias.
 *
 * Mede: throughput, latência p50/p95/p99, taxa de erro, conflitos de lock, retries, outbox lag
 * e, no fim, verifica saldo == ledger para todas as wallets do banco.
 *
 * Requer: bun run infra:up && bun run migration:up. Não rode `bun run start` nem outros testes junto.
 *
 * Parâmetros (variáveis de ambiente):
 *   LOAD_INSTANCES=3  LOAD_CONCURRENCY=50  LOAD_DURATION_S=30  LOAD_HOT_DURATION_S=15
 *   LOAD_WALLETS=200  LOAD_SQS_MESSAGES=3000  LOAD_DB_POOL_MAX=10
 */
import { PurgeQueueCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { config } from "../../src/infrastructure/config";
import { createSqsClient, resolveQueueUrl } from "../../src/infrastructure/sqs/sqs-client";
import { AppInstance } from "../concurrency/instances";
import { createHarness, openWallet, sql, uuid } from "../integration/harness";

// ------------------------------------------------------------- parâmetros

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const PARAMS = {
  instances: env("LOAD_INSTANCES", 3),
  concurrency: env("LOAD_CONCURRENCY", 50),
  durationS: env("LOAD_DURATION_S", 30),
  hotDurationS: env("LOAD_HOT_DURATION_S", 15),
  wallets: env("LOAD_WALLETS", 200),
  sqsMessages: env("LOAD_SQS_MESSAGES", 3000),
  dbPoolMax: env("LOAD_DB_POOL_MAX", 10),
  warmupS: 5,
};
const INSTANCE_ENV = {
  DB_POOL_MAX: String(PARAMS.dbPoolMax),
  // warn: o log por requisição em info vira I/O de disco e distorce a medição.
  LOG_LEVEL: "warn",
  SQS_VISIBILITY_TIMEOUT_SECONDS: "30",
  SQS_WAIT_TIME_SECONDS: "5",
  OUTBOX_INTERVAL_MS: "200",
};
const RUN = `load-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const ROOT = join(import.meta.dir, "..", "..");
const RESULTS_DIR = join(ROOT, "load-test-results");

// ---------------------------------------------------------------- tipos

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

interface PhaseResult {
  name: string;
  description: string;
  durationS: number;
  concurrency: number;
  requests: number;
  throughput: number;
  latencyMs: LatencyStats;
  statuses: Record<string, number>;
  networkErrors: number;
  errorRate: number;
  businessRejections: number;
  lockConflicts: number;
  retries: number;
  retriesByComponent: Record<string, number>;
  outbox: { maxLagS: number; maxPending: number };
  /** Tempo para a outbox zerar depois do fim do cenário. */
  outboxDrainS?: number;
}

interface SqsResult {
  messages: number;
  wallets: number;
  enqueueS: number;
  drainS: number;
  throughput: number;
  endToEndMs: LatencyStats;
  lockConflicts: number;
  retries: number;
  retriesByComponent: Record<string, number>;
  outbox: { maxLagS: number; maxPending: number };
  outboxDrainS?: number;
}

// ------------------------------------------------------------- utilitários

/** Valores de teste gerados em centavos inteiros e enviados como string decimal (o contrato). */
const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

function stats(values: number[]): LatencyStats {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

function metricSum(text: string, name: string): number {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// ------------------------------------------------------------ infraestrutura

const harness = await createHarness();
const sqs = createSqsClient();
const queueUrl = await resolveQueueUrl(sqs, config.queues.wagerTransactions);
const basePort = 45_000 + Math.floor(Math.random() * 1_000) * 4;
const instances = Array.from(
  { length: PARAMS.instances },
  (_, i) => new AppInstance(`load-${i + 1}`, basePort + i, INSTANCE_ENV),
);

interface Scrape {
  lockConflicts: number;
  retries: number;
  retriesByComponent: Record<string, number>;
  outboxLagS: number;
  outboxPending: number;
}

function retriesByComponent(texts: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const match = /^wager_retries_total\{component="([^"]+)"\} (\S+)$/.exec(line);
      if (match?.[1]) result[match[1]] = (result[match[1]] ?? 0) + Number(match[2]);
    }
  }
  return result;
}

function diff(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const delta = value - (before[key] ?? 0);
    if (delta !== 0) result[key] = delta;
  }
  return result;
}

async function scrape(): Promise<Scrape> {
  const texts = await Promise.all(
    instances.map(async (instance) => {
      try {
        return await (await fetch(`${instance.baseUrl}/metrics`)).text();
      } catch {
        return "";
      }
    }),
  );
  const first = texts.find((t) => t.length > 0) ?? "";
  return {
    // Contadores são por instância: soma. Os gauges da outbox são globais (vêm do banco): uma leitura basta.
    lockConflicts: texts.reduce((sum, t) => sum + metricSum(t, "wallet_lock_conflicts_total"), 0),
    retries: texts.reduce((sum, t) => sum + metricSum(t, "wager_retries_total"), 0),
    retriesByComponent: retriesByComponent(texts),
    outboxLagS: metricSum(first, "outbox_lag_seconds"),
    outboxPending: metricSum(first, "outbox_pending_messages"),
  };
}

/** Amostra a outbox a cada segundo enquanto a fase roda. */
function startOutboxSampler(): () => { maxLagS: number; maxPending: number } {
  let maxLagS = 0;
  let maxPending = 0;
  let running = true;
  void (async () => {
    while (running) {
      const sample = await scrape();
      maxLagS = Math.max(maxLagS, sample.outboxLagS);
      maxPending = Math.max(maxPending, sample.outboxPending);
      await Bun.sleep(1000);
    }
  })();
  return () => {
    running = false;
    return { maxLagS: Math.round(maxLagS * 100) / 100, maxPending };
  };
}

async function outboxPending(): Promise<number> {
  const [row] = await sql<{ n: number }>(harness, `select count(*)::int as n from outbox_messages where published_at is null`);
  return Number(row?.n ?? 0);
}

async function waitOutboxEmpty(timeoutS: number): Promise<number> {
  const started = performance.now();
  while ((performance.now() - started) / 1000 < timeoutS) {
    if ((await outboxPending()) === 0) return (performance.now() - started) / 1000;
    await Bun.sleep(500);
  }
  throw new Error(`outbox did not drain within ${timeoutS}s`);
}

// ------------------------------------------------------------- cenários HTTP

type Wallet = Awaited<ReturnType<typeof openWallet>>;

function wagerBody(wallet: Wallet, kind: string, cents: number) {
  const externalTransactionId = `${RUN}-${uuid()}`;
  return {
    key: `load:${externalTransactionId}`,
    body: JSON.stringify({
      providerId: "load",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${randomInt(1, 1000)}`,
      gameId: "load-test",
      kind,
      money: { amount: money(cents), currency: "BRL" },
    }),
  };
}

async function runHttpPhase(options: {
  name: string;
  description: string;
  durationS: number;
  measure: boolean;
  pick: () => Wallet;
}): Promise<PhaseResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const accepted: Array<{ key: string; body: string }> = [];
  let networkErrors = 0;
  let next = 0;

  const before = await scrape();
  const stopSampler = startOutboxSampler();
  const started = performance.now();
  const deadline = started + options.durationS * 1000;

  const vu = async () => {
    while (performance.now() < deadline) {
      const roll = Math.random();
      let request: { key: string; body: string };
      if (roll < 0.05 && accepted.length > 0) {
        request = accepted[randomInt(0, accepted.length - 1)] as { key: string; body: string }; // replay
      } else if (roll < 0.8) {
        request = wagerBody(options.pick(), "BET", randomInt(100, 2000));
      } else if (roll < 0.95) {
        request = wagerBody(options.pick(), "WIN", randomInt(0, 4000) || 1);
      } else {
        request = wagerBody(options.pick(), "LOSS", randomInt(100, 2000));
      }
      const instance = instances[next++ % instances.length] as AppInstance;
      const t0 = performance.now();
      try {
        const response = await fetch(`${instance.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": request.key },
          body: request.body,
        });
        await response.arrayBuffer();
        latencies.push(performance.now() - t0);
        statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
        if (response.status === 201 && accepted.length < 10_000) accepted.push(request);
      } catch {
        latencies.push(performance.now() - t0);
        networkErrors++;
      }
    }
  };
  await Promise.all(Array.from({ length: PARAMS.concurrency }, vu));

  const elapsedS = (performance.now() - started) / 1000;
  const outbox = stopSampler();
  const after = await scrape();
  const requests = latencies.length;
  const serverErrors = Object.entries(statuses)
    .filter(([status]) => Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);
  const unexpected = Object.entries(statuses)
    .filter(([status]) => !["200", "201", "202", "422"].includes(status) && Number(status) < 500)
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    name: options.name,
    description: options.description,
    durationS: Math.round(elapsedS * 100) / 100,
    concurrency: PARAMS.concurrency,
    requests,
    throughput: Math.round((requests / elapsedS) * 10) / 10,
    latencyMs: stats(latencies),
    statuses,
    networkErrors,
    errorRate: requests ? Math.round(((serverErrors + unexpected + networkErrors) / requests) * 10_000) / 100 : 0,
    businessRejections: statuses["422"] ?? 0,
    lockConflicts: after.lockConflicts - before.lockConflicts,
    retries: after.retries - before.retries,
    retriesByComponent: diff(after.retriesByComponent, before.retriesByComponent),
    outbox,
  };
}

// --------------------------------------------------------------- cenário SQS

async function runSqsPhase(wallets: Wallet[]): Promise<SqsResult> {
  const prefix = `${RUN}-sqs`;
  const sentAt = new Map<string, number>();
  const messages = Array.from({ length: PARAMS.sqsMessages }, (_, i) => {
    const wallet = wallets[i % wallets.length] as Wallet;
    const externalTransactionId = `${prefix}-${uuid()}`;
    const idempotencyKey = `load:${externalTransactionId}`;
    return {
      idempotencyKey,
      walletId: wallet.id,
      body: JSON.stringify({
        messageId: `${prefix}-msg-${uuid()}`,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "load",
          externalTransactionId,
          idempotencyKey,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "round-sqs",
          gameId: "load-test",
          kind: "BET",
          money: { amount: money(randomInt(100, 500)), currency: "BRL" },
        },
      }),
    };
  });

  const before = await scrape();
  const stopSampler = startOutboxSampler();
  const started = performance.now();

  // Enfileira em lotes de 10 (limite do SQS), 20 lotes em paralelo.
  const batches: (typeof messages)[] = [];
  for (let i = 0; i < messages.length; i += 10) batches.push(messages.slice(i, i + 10));
  for (let i = 0; i < batches.length; i += 20) {
    await Promise.all(
      batches.slice(i, i + 20).map(async (batch) => {
        await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: batch.map((m, j) => ({
              Id: String(j),
              MessageBody: m.body,
              MessageGroupId: m.walletId,
              MessageDeduplicationId: uuid(),
            })),
          }),
        );
        const now = Date.now();
        for (const m of batch) sentAt.set(m.idempotencyKey, now);
      }),
    );
  }
  const enqueueS = (performance.now() - started) / 1000;
  log(`  ${messages.length} mensagens enfileiradas em ${enqueueS.toFixed(1)}s`);

  // Espera todas serem processadas.
  const countProcessed = async () => {
    const [row] = await sql<{ n: number }>(
      harness,
      `select count(*)::int as n from wager_transactions where idempotency_key like ? and processed_at is not null`,
      [`load:${prefix}%`],
    );
    return Number(row?.n ?? 0);
  };
  let processed = 0;
  while (processed < messages.length) {
    if ((performance.now() - started) / 1000 > 600) throw new Error(`SQS phase timed out at ${processed} messages`);
    await Bun.sleep(500);
    processed = await countProcessed();
  }
  const drainS = (performance.now() - started) / 1000;
  const outbox = stopSampler();
  const after = await scrape();

  // Latência ponta a ponta: envio (cliente) -> processed_at (gravado pela aplicação, mesmo relógio do host).
  const rows = await sql<{ key: string; t: string }>(
    harness,
    `select idempotency_key as key, (extract(epoch from processed_at) * 1000)::text as t
       from wager_transactions where idempotency_key like ?`,
    [`load:${prefix}%`],
  );
  const endToEnd = rows
    .map((row) => Number(row.t) - (sentAt.get(row.key) ?? Number.NaN))
    .filter((v) => Number.isFinite(v) && v >= 0);

  return {
    messages: messages.length,
    wallets: wallets.length,
    enqueueS: Math.round(enqueueS * 100) / 100,
    drainS: Math.round(drainS * 100) / 100,
    throughput: Math.round((messages.length / drainS) * 10) / 10,
    endToEndMs: stats(endToEnd),
    lockConflicts: after.lockConflicts - before.lockConflicts,
    retries: after.retries - before.retries,
    retriesByComponent: diff(after.retriesByComponent, before.retriesByComponent),
    outbox,
  };
}

// ------------------------------------------------------------------- relatório

async function environment() {
  const [pg] = await sql<{ version: string }>(harness, `select version()`);
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
    cpu: `${cpus[0]?.model.trim() ?? "?"} — ${cpus.length} threads`,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    bun: Bun.version,
    postgres: pg?.version.split(",")[0] ?? "?",
    broker: "LocalStack 3 (SQS FIFO), Docker",
    note: "Gerador de carga, instâncias da aplicação, PostgreSQL e LocalStack na mesma máquina.",
  };
}

function phaseTable(results: PhaseResult[]): string {
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.concurrency} | ${r.durationS}s | ${r.requests} | **${r.throughput}** | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} | ${r.errorRate}% | ${r.businessRejections} | ${r.lockConflicts} | ${r.retries} | ${r.outbox.maxLagS}s / ${r.outbox.maxPending} | ${r.outboxDrainS ?? "?"}s |`,
  );
  return [
    "| Cenário | Clientes | Duração | Requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | Erro | 422 | Conflitos de lock | Retries | Outbox lag máx / pendentes máx | Outbox zera em |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function markdown(report: Record<string, unknown> & {
  environment: Awaited<ReturnType<typeof environment>>;
  http: PhaseResult[];
  sqs: SqsResult;
  consistency: { wallets: number; inconsistent: number };
}): string {
  const e = report.environment;
  const s = report.sqs;
  return `# Resultado do teste de carga — ${e.date}

## Ambiente

- SO: ${e.os}
- CPU: ${e.cpu}
- Memória: ${e.memoryGb} GB
- Bun ${e.bun} · ${e.postgres} · ${e.broker}
- ${e.note}

## Parâmetros

\`\`\`json
${JSON.stringify({ ...PARAMS, instanceEnv: INSTANCE_ENV }, null, 2)}
\`\`\`

## HTTP

${phaseTable(report.http)}

Status HTTP por cenário:

${report.http.map((r) => `- ${r.name}: ${JSON.stringify(r.statuses)}${r.networkErrors ? `, erros de rede: ${r.networkErrors}` : ""}; retries por componente: ${JSON.stringify(r.retriesByComponent)}`).join("\n")}

## SQS

| Mensagens | Wallets | Enfileiramento | Até processar todas | msg/s | p50 ponta a ponta | p95 | p99 | máx | Conflitos de lock | Retries | Outbox lag máx / pendentes máx | Outbox zera em |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ${s.messages} | ${s.wallets} | ${s.enqueueS}s | ${s.drainS}s | **${s.throughput}** | ${s.endToEndMs.p50} ms | ${s.endToEndMs.p95} ms | ${s.endToEndMs.p99} ms | ${s.endToEndMs.max} ms | ${s.lockConflicts} | ${s.retries} | ${s.outbox.maxLagS}s / ${s.outbox.maxPending} | ${s.outboxDrainS ?? "?"}s |

Retries por componente: ${JSON.stringify(s.retriesByComponent)}

## Outbox e consistência

- Invariante saldo == ledger: ${report.consistency.wallets} wallets verificadas, **${report.consistency.inconsistent} inconsistentes**
`;
}

// ------------------------------------------------------------------- execução

try {
  log(`iniciando ${PARAMS.instances} instâncias`);
  for (const url of [queueUrl]) {
    try {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
    } catch {
      // purge recente: segue sem limpar
    }
  }
  await Promise.all(instances.map((instance) => instance.start()));

  log("aguardando a outbox acumulada por execuções anteriores ser publicada");
  const backlogS = await waitOutboxEmpty(600);
  log(`  outbox vazia em ${backlogS.toFixed(1)}s`);

  log(`criando ${PARAMS.wallets} wallets`);
  const wallets: Wallet[] = [];
  for (let i = 0; i < PARAMS.wallets; i += 20) {
    wallets.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(20, PARAMS.wallets - i) }, () => openWallet(harness, "5000.00")),
      )),
    );
  }
  const hotWallet = await openWallet(harness, "100000000.00");
  await waitOutboxEmpty(120);

  log(`aquecimento (${PARAMS.warmupS}s, não medido)`);
  await runHttpPhase({
    name: "aquecimento",
    description: "",
    durationS: PARAMS.warmupS,
    measure: false,
    pick: () => wallets[randomInt(0, wallets.length - 1)] as Wallet,
  });
  await waitOutboxEmpty(120);

  log(`cenário 1: HTTP em ${PARAMS.wallets} wallets por ${PARAMS.durationS}s com ${PARAMS.concurrency} clientes`);
  const distributed = await runHttpPhase({
    name: `HTTP, ${PARAMS.wallets} wallets`,
    description: "75% BET, 15% WIN, 5% LOSS, 5% replay de uma chave já aceita",
    durationS: PARAMS.durationS,
    measure: true,
    pick: () => wallets[randomInt(0, wallets.length - 1)] as Wallet,
  });
  log(`  ${distributed.throughput} req/s, p95 ${distributed.latencyMs.p95} ms`);
  distributed.outboxDrainS = Math.round((await waitOutboxEmpty(600)) * 100) / 100;
  log(`  outbox zerou ${distributed.outboxDrainS}s depois do fim do cenário`);

  log(`cenário 2: HTTP numa única wallet por ${PARAMS.hotDurationS}s com ${PARAMS.concurrency} clientes`);
  const hot = await runHttpPhase({
    name: "HTTP, 1 wallet quente",
    description: "mesma mistura, todos os clientes na mesma wallet",
    durationS: PARAMS.hotDurationS,
    measure: true,
    pick: () => hotWallet,
  });
  log(`  ${hot.throughput} req/s, p95 ${hot.latencyMs.p95} ms`);
  hot.outboxDrainS = Math.round((await waitOutboxEmpty(600)) * 100) / 100;

  log(`cenário 3: ${PARAMS.sqsMessages} mensagens SQS em ${Math.min(PARAMS.wallets, 100)} wallets`);
  const sqsResult = await runSqsPhase(wallets.slice(0, 100));
  log(`  ${sqsResult.throughput} msg/s, p95 ponta a ponta ${sqsResult.endToEndMs.p95} ms`);

  sqsResult.outboxDrainS = Math.round((await waitOutboxEmpty(600)) * 100) / 100;

  const [consistency] = await sql<{ inconsistent: number; wallets: number }>(
    harness,
    `select count(*) filter (where w.balance <> coalesce(l.total, 0))::int as inconsistent, count(*)::int as wallets
       from wallets w
       left join (select wallet_id, sum(case direction when 'CREDIT' then amount else -amount end) as total
                    from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id`,
  );

  const report = {
    environment: await environment(),
    params: PARAMS,
    instanceEnv: INSTANCE_ENV,
    backlogDrainBeforeLoadS: Math.round(backlogS * 100) / 100,
    http: [distributed, hot],
    sqs: sqsResult,
    consistency: { wallets: Number(consistency?.wallets ?? 0), inconsistent: Number(consistency?.inconsistent ?? -1) },
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const md = markdown(report);
  writeFileSync(join(RESULTS_DIR, `${RUN}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(RESULTS_DIR, `${RUN}.md`), md);
  writeFileSync(join(RESULTS_DIR, "latest.md"), md);

  console.log(`\n${md}`);
  log(`relatório gravado em load-test-results/${RUN}.md (e latest.md)`);
  if (report.consistency.inconsistent !== 0) process.exitCode = 1;
} finally {
  await Promise.all(instances.map((instance) => instance.kill().catch(() => undefined)));
  sqs.destroy();
  await harness.close();
}
