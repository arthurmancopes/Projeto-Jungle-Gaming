import { EntitySchema } from "@mikro-orm/core";

/**
 * Mapeamento de persistência (linhas das tabelas). São estruturas de dados puras:
 * o modelo de domínio fica em src/domain e é reconstruído pelos mappers via rehydrate.
 *
 * Valores monetários: coluna numeric(20,2), lida e gravada como STRING. Nunca number.
 */
const MONEY = { type: "string", columnType: "numeric(20,2)" } as const;
const TIMESTAMP = { type: "datetime", columnType: "timestamptz" } as const;

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: "WalletRow",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", columnType: "char(3)" },
    balance: MONEY,
    version: { type: "integer" },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
});

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status: string;
  failureCode?: string | null;
  observedBalance?: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: "WagerTransactionRow",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string", columnType: "char(64)" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: MONEY,
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    observedBalance: { ...MONEY, nullable: true },
    referenceAttempts: { type: "integer" },
    nextReferenceAttemptAt: { ...TIMESTAMP, nullable: true },
    createdAt: TIMESTAMP,
    processedAt: { ...TIMESTAMP, nullable: true },
  },
});

export interface LedgerEntryRow {
  id: string;
  seq?: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  name: "LedgerEntryRow",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    seq: { type: "string", columnType: "bigint", nullable: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: MONEY,
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: MONEY,
    balanceAfter: MONEY,
    createdAt: TIMESTAMP,
  },
});

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  name: "InboxMessageRow",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string", columnType: "char(64)" },
    receivedAt: TIMESTAMP,
    processedAt: { ...TIMESTAMP, nullable: true },
  },
});

export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  name: "OutboxMessageRow",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: TIMESTAMP,
    attempts: { type: "integer" },
    nextAttemptAt: { ...TIMESTAMP, nullable: true },
    publishedAt: { ...TIMESTAMP, nullable: true },
  },
});

export const schemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
