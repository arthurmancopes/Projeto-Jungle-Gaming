/** Configuração por variáveis de ambiente, com padrões que funcionam no Docker Compose local. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  aws: {
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
  queues: {
    wagerTransactions: "wager-transactions.fifo",
    wagerTransactionsDlq: "wager-transactions-dlq.fifo",
    events: "wagering-events.fifo",
  },
  workers: {
    /** WORKERS_ENABLED=false sobe só a API HTTP (sem consumidor nem workers). */
    enabled: process.env.WORKERS_ENABLED !== "false",
    outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 500),
    pendingReferenceIntervalMs: Number(process.env.PENDING_REFERENCE_INTERVAL_MS ?? 1000),
    shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 20_000),
  },
} as const;
