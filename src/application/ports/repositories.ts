import type { InboxMessage } from "../../domain/inbox-message";
import type { WalletLedgerEntry } from "../../domain/ledger-entry";
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
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface InboxRepository {
  /** false quando (consumerName, messageId) já foi recebido. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}
