import { FailureCode, InvariantViolationError } from "./errors";
import { LedgerDirection, type WalletLedgerEntry } from "./ledger-entry";
import type { Wallet } from "./wallet";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

/** Política de reprocessamento de referências ausentes (seção 7.1 do desafio). */
export const MAX_REFERENCE_ATTEMPTS = 10;
export const MAX_REFERENCE_DELAY_SECONDS = 60;

/** Backoff exponencial: 1s, 2s, 4s ... limitado a 60s. */
export function referenceRetryDelaySeconds(attempt: number): number {
  return Math.min(2 ** attempt, MAX_REFERENCE_DELAY_SECONDS);
}

export type WagerOutcome =
  | { status: WagerTransactionStatus.Processed; entry?: WalletLedgerEntry }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

export interface ApplyWagerInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Transação referenciada, resolvida por (providerId, referenceExternalTransactionId). */
  reference?: WagerTransaction;
  /** true se já existe uma reversão PROCESSED apontando para a referência. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
}

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Regras de negócio de BET / WIN / LOSS / REFUND / ROLLBACK.
 * Função pura de domínio: muta a wallet e a transação em memória e devolve o lançamento
 * (quando há). Persistência, locks e eventos ficam por conta do caso de uso.
 */
export function applyWagerTransaction(input: ApplyWagerInput): WagerOutcome {
  const { wallet, transaction: tx, reference, now } = input;

  if (tx.kind === WagerTransactionKind.Opening) {
    throw new InvariantViolationError("OPENING is applied only when the wallet is opened");
  }
  if (tx.walletId !== wallet.id || tx.playerId !== wallet.playerId) {
    throw new InvariantViolationError("transaction does not belong to this wallet");
  }

  const reject = (failureCode: FailureCode): WagerOutcome => {
    tx.reject(failureCode, { observedBalance: wallet.balance, at: now });
    return { status: WagerTransactionStatus.Rejected, failureCode };
  };

  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (tx.resolvesReference()) {
    if (!reference || reference.status === WagerTransactionStatus.PendingReference) {
      return deferOrGiveUp(tx, wallet, now);
    }
    const failure = validateReference(tx, reference, input.referenceAlreadyReversed);
    if (failure) return reject(failure);
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed({ observedBalance: wallet.balance, at: now });
    return { status: WagerTransactionStatus.Processed };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = { entryId: input.ledgerEntryId, transactionId: tx.id, money: tx.money, at: now };

  let entry: WalletLedgerEntry;
  if (direction === LedgerDirection.Debit) {
    if (!wallet.canDebit(tx.money)) {
      // Aposta sem saldo e reversão que negativaria o saldo são situações distintas.
      return reject(
        tx.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalWouldOverdraw,
      );
    }
    entry = wallet.debit(movement);
  } else {
    entry = wallet.credit(movement);
  }

  tx.markProcessed({
    referenceTransactionId: tx.resolvesReference() ? reference?.id : undefined,
    observedBalance: wallet.balance,
    at: now,
  });
  return { status: WagerTransactionStatus.Processed, entry };
}

function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  if (
    reference.providerId !== tx.providerId ||
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.roundId !== tx.roundId
  ) {
    return FailureCode.ReferenceMismatch;
  }
  if (reference.money.currency !== tx.money.currency) {
    return FailureCode.CurrencyMismatch;
  }
  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(reference.kind)) {
    return FailureCode.InvalidReferenceKind;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (tx.requiresReference()) {
    if (!reference.money.equals(tx.money)) {
      return FailureCode.AmountMismatch;
    }
    if (alreadyReversed) {
      return FailureCode.AlreadyReversed;
    }
  }
  return undefined;
}

function deferOrGiveUp(tx: WagerTransaction, wallet: Wallet, now: Date): WagerOutcome {
  if (tx.status === WagerTransactionStatus.Pending) {
    tx.markPendingReference(addSeconds(now, referenceRetryDelaySeconds(0)));
    return { status: WagerTransactionStatus.PendingReference };
  }
  const attempts = tx.referenceAttempts + 1;
  if (attempts >= MAX_REFERENCE_ATTEMPTS) {
    tx.reject(FailureCode.ReferenceNotFound, { observedBalance: wallet.balance, at: now });
    return { status: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReferenceNotFound };
  }
  tx.scheduleReferenceRetry(addSeconds(now, referenceRetryDelaySeconds(attempts)));
  return { status: WagerTransactionStatus.PendingReference };
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
