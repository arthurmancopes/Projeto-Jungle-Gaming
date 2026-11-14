import { InvariantViolationError, type FailureCode } from "../errors";
import type { MoneyProps } from "../money";
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from "../wager-transaction";
import { IntegrationEvent, type EventContext } from "./integration-event";

interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function baseData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvariantViolationError(`cannot emit ${expected} event for transaction in ${tx.status}`);
  }
}

// ---------------------------------------------------------------- Processed

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  /** Saldo da wallet após a aplicação (igual ao anterior para LOSS). */
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    if (!tx.observedBalance || !tx.processedAt) {
      throw new InvariantViolationError("processed transaction without observed balance");
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        ...(tx.referenceTransactionId !== undefined
          ? { referenceTransactionId: tx.referenceTransactionId }
          : {}),
        balance: tx.observedBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

// ----------------------------------------------------------------- Rejected

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  rejectedAt: string;
}

/** Transação rejeitada por regra de negócio (inclui referência nunca encontrada). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    if (!tx.failureCode || !tx.processedAt) {
      throw new InvariantViolationError("rejected transaction without failure code");
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        failureCode: tx.failureCode,
        rejectedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

// --------------------------------------------------------- PendingReference

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

/** Referência ausente: a transação foi aceita e será reprocessada pelo worker. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    if (tx.referenceExternalTransactionId === undefined || !tx.nextReferenceAttemptAt) {
      throw new InvariantViolationError("pending-reference transaction without reference data");
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}
