import type { InboxMessage } from "../../domain/inbox-message";
import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import type { Money } from "../../domain/money";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";

export interface WalletRepository {
  /** false quando já existe wallet para o mesmo playerId + currency. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  findById(id: string): Promise<Wallet | undefined>;
  /** Carrega a wallet com lock exclusivo de linha (SELECT ... FOR NO KEY UPDATE). */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** UPDATE condicionado à version lida; lança ConcurrencyConflictError se ela mudou. */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /** false quando a idempotency key ou o par (providerId, externalTransactionId) já existem. */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** true se já existe REFUND/ROLLBACK PROCESSED apontando para a transação. */
  existsProcessedReversalOf(transactionId: string): Promise<boolean>;
  /** Ids das transações PENDING_REFERENCE cuja próxima tentativa já venceu (leitura sem lock). */
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  /**
   * Trava a transação para reprocessamento se ela ainda estiver PENDING_REFERENCE.
   * undefined quando outro worker já a travou (SKIP LOCKED) ou ela já saiu desse estado.
   */
  lockPendingReference(id: string): Promise<WagerTransaction | undefined>;
}

export interface LedgerPageItem {
  /** Posição estável do lançamento (sequência monotônica do banco); base do cursor. */
  seq: string;
  entry: WalletLedgerEntry;
}

export interface LedgerReconciliation {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Lançamentos da wallet em ordem de seq, depois de afterSeq (exclusivo). */
  listByWallet(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]>;
  /** Saldo materializado e saldo recalculado pelo ledger, lidos no mesmo snapshot. */
  reconcile(walletId: string): Promise<LedgerReconciliation | undefined>;
}

export interface InboxRepository {
  /** false quando (consumerName, messageId) já foi recebido. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /**
   * Reserva um lote de mensagens pendentes e vencidas com FOR UPDATE SKIP LOCKED:
   * publishers concorrentes recebem lotes disjuntos, sem esperar uns pelos outros.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Grava o resultado da tentativa (publicada, ou nova tentativa agendada). */
  save(message: OutboxMessage): Promise<void>;
}
