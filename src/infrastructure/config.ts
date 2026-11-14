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
} as const;
