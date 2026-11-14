import type { FailureCode } from "../../domain/errors";
import { InboxMessage } from "../../domain/inbox-message";
import { WalletLedgerEntry, type LedgerDirection } from "../../domain/ledger-entry";
import { Money } from "../../domain/money";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { OutboxMessage } from "../../domain/outbox-message";
import type {
  InboxMessageRow,
  LedgerEntryRow,
  OutboxMessageRow,
  WagerTransactionRow,
  WalletRow,
} from "./schemas";

/**
 * Guarda de precisão: o driver devolve numeric como string. Se algum dia chegar
 * um number aqui, a leitura falha em vez de carregar um valor possivelmente impreciso.
 */
export function toMoney(amount: unknown, currency: string): Money {
  if (typeof amount !== "string") {
    throw new TypeError(`numeric column must be read as string, got ${typeof amount}`);
  }
  return Money.rehydrate({ amount, currency });
}

/** Aceita Date ou o texto de timestamptz do PostgreSQL ("2026-11-14 13:00:00.123+00"). */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    let text = value.trim().replace(" ", "T");
    if (/[+-]\d{2}$/.test(text)) text += ":00";
    else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) text += "Z";
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new TypeError(`invalid timestamp value: ${String(value)}`);
}

function toOptionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : toDate(value);
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: toMoney(row.balance, row.currency),
    version: Number(row.version),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  });
}

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: toMoney(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: toDate(row.createdAt),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: toOptionalDate(row.processedAt),
    observedBalance:
      row.observedBalance === null || row.observedBalance === undefined
        ? undefined
        : toMoney(row.observedBalance, row.currency),
    referenceAttempts: Number(row.referenceAttempts),
    nextReferenceAttemptAt: toOptionalDate(row.nextReferenceAttemptAt),
  });
}

export function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: toMoney(row.amount, row.currency),
    balanceBefore: toMoney(row.balanceBefore, row.currency),
    balanceAfter: toMoney(row.balanceAfter, row.currency),
    createdAt: toDate(row.createdAt),
  });
}

export function toInboxMessage(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: toDate(row.receivedAt),
    processedAt: toOptionalDate(row.processedAt),
  });
}

export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  // jsonb chega como objeto; aceita texto por segurança.
  const payload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>;
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload,
    occurredAt: toDate(row.occurredAt),
    attempts: Number(row.attempts),
    nextAttemptAt: toOptionalDate(row.nextAttemptAt),
    publishedAt: toOptionalDate(row.publishedAt),
  });
}
