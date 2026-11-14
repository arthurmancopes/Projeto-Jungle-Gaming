import type { QueryResult } from "@mikro-orm/core";
import type { SqlEntityManager } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError } from "../../application/errors";
import type {
  InboxRepository,
  LedgerPageItem,
  LedgerReconciliation,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports/repositories";
import type { TransactionContext } from "../../application/ports/unit-of-work";
import type { InboxMessage } from "../../domain/inbox-message";
import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import {
  toInboxMessage,
  toLedgerEntry,
  toMoney,
  toOutboxMessage,
  toWagerTransaction,
  toWallet,
} from "./mappers";
import {
  InboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
  type InboxMessageRow,
  type LedgerEntryRow,
  type OutboxMessageRow,
  type WagerTransactionRow,
  type WalletRow,
} from "./schemas";

/**
 * Repositórios sobre o EntityManager de UMA transação.
 *
 * - Leituras usam o QueryBuilder e devolvem linhas puras (sem identity map), para que
 *   uma leitura com lock nunca reaproveite um estado lido antes do lock.
 * - Escritas são SQL explícito: INSERT ... ON CONFLICT DO NOTHING e UPDATE condicionado
 *   são a própria garantia de idempotência e concorrência, então ficam visíveis.
 */

async function run(em: SqlEntityManager, sql: string, params: unknown[]): Promise<number> {
  const result = await em.execute<QueryResult>(sql, params, "run");
  return result.affectedRows;
}

const nullable = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const affected = await run(
      this.em,
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (player_id, currency) do nothing`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    return affected === 1;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em
      .createQueryBuilder(WalletSchema)
      .select("*")
      .where({ id })
      .execute<WalletRow | undefined>("get");
    return row ? toWallet(row) : undefined;
  }

  /**
   * FOR NO KEY UPDATE, e não FOR UPDATE: é o lock que um UPDATE de colunas não-chave já toma.
   * O INSERT em wager_transactions (FK para wallets) pega FOR KEY SHARE na linha da wallet;
   * FOR UPDATE conflita com esse lock, e duas transações que já inseriram sua linha entrariam
   * em deadlock ao pedir o lock da wallet. FOR NO KEY UPDATE é compatível com FOR KEY SHARE
   * e continua exclusivo entre processadores da mesma wallet.
   */
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute<WalletRow[]>(
      `select id, player_id as "playerId", currency, balance, version,
              created_at as "createdAt", updated_at as "updatedAt"
         from wallets
        where id = ?
          for no key update`,
      [id],
    );
    const row = rows[0];
    return row ? toWallet(row) : undefined;
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await run(
      this.em,
      `update wallets set balance = ?, version = ?, updated_at = ? where id = ? and version = ?`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`wallet ${wallet.id} changed since it was read (version ${expectedVersion})`);
    }
  }
}

const TRANSACTION_COLUMNS = `
  id, provider_id as "providerId", external_transaction_id as "externalTransactionId",
  idempotency_key as "idempotencyKey", payload_hash as "payloadHash", wallet_id as "walletId",
  player_id as "playerId", round_id as "roundId", game_id as "gameId", kind, amount, currency,
  reference_external_transaction_id as "referenceExternalTransactionId",
  reference_transaction_id as "referenceTransactionId", status, failure_code as "failureCode",
  observed_balance as "observedBalance", reference_attempts as "referenceAttempts",
  next_reference_attempt_at as "nextReferenceAttemptAt", created_at as "createdAt",
  processed_at as "processedAt"`;

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    // Sem alvo no ON CONFLICT: cobre tanto idempotency_key quanto (provider_id, external_transaction_id).
    const affected = await run(
      this.em,
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         reference_external_transaction_id, reference_transaction_id, status, failure_code,
         observed_balance, reference_attempts, next_reference_attempt_at, created_at, processed_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        nullable(tx.referenceExternalTransactionId),
        nullable(tx.referenceTransactionId),
        tx.status,
        nullable(tx.failureCode),
        nullable(tx.observedBalance?.amount),
        tx.referenceAttempts,
        nullable(tx.nextReferenceAttemptAt),
        tx.createdAt,
        nullable(tx.processedAt),
      ],
    );
    return affected === 1;
  }

  async update(tx: WagerTransaction): Promise<void> {
    await run(
      this.em,
      `update wager_transactions
          set status = ?, reference_transaction_id = ?, failure_code = ?, observed_balance = ?,
              reference_attempts = ?, next_reference_attempt_at = ?, processed_at = ?
        where id = ?`,
      [
        tx.status,
        nullable(tx.referenceTransactionId),
        nullable(tx.failureCode),
        nullable(tx.observedBalance?.amount),
        tx.referenceAttempts,
        nullable(tx.nextReferenceAttemptAt),
        nullable(tx.processedAt),
        tx.id,
      ],
    );
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async existsProcessedReversalOf(transactionId: string): Promise<boolean> {
    const rows = await this.em.execute(
      `select 1 from wager_transactions
        where reference_transaction_id = ?
          and kind in ('REFUND', 'ROLLBACK')
          and status = 'PROCESSED'
        limit 1`,
      [transactionId],
    );
    return rows.length > 0;
  }

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
        order by next_reference_attempt_at
        limit ?`,
      [now, limit],
    );
    return rows.map((row) => row.id);
  }

  async lockPendingReference(id: string): Promise<WagerTransaction | undefined> {
    // O status é reavaliado sob o lock: se outro worker concluiu a transação, a linha não volta.
    const rows = await this.em.execute<WagerTransactionRow[]>(
      `select ${TRANSACTION_COLUMNS}
         from wager_transactions
        where id = ? and status = 'PENDING_REFERENCE'
          for no key update skip locked`,
      [id],
    );
    const row = rows[0];
    return row ? toWagerTransaction(row) : undefined;
  }

  private async findOne(where: Partial<WagerTransactionRow>): Promise<WagerTransaction | undefined> {
    const row = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .select("*")
      .where(where)
      .execute<WagerTransactionRow | undefined>("get");
    return row ? toWagerTransaction(row) : undefined;
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await run(
      this.em,
      `insert into wallet_ledger_entries (
         id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.amount,
        entry.money.currency,
        entry.balanceBefore.amount,
        entry.balanceAfter.amount,
        entry.createdAt,
      ],
    );
  }

  async listByWallet(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]> {
    const rows = await this.em.execute<LedgerEntryRow[]>(
      `select id, seq, wallet_id as "walletId", transaction_id as "transactionId", direction, amount, currency,
              balance_before as "balanceBefore", balance_after as "balanceAfter", created_at as "createdAt"
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?::bigint
        order by seq
        limit ?`,
      [walletId, afterSeq ?? "0", limit],
    );
    return rows.map((row) => ({ seq: String(row.seq), entry: toLedgerEntry(row) }));
  }

  async reconcile(walletId: string): Promise<LedgerReconciliation | undefined> {
    // Uma única instrução = um único snapshot: saldo e soma do ledger são sempre do mesmo instante.
    const rows = await this.em.execute<
      Array<{ currency: string; stored: string; calculated: string; entries: string }>
    >(
      `select w.currency,
              w.balance::text as stored,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated,
              count(l.id)::text as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      storedBalance: toMoney(row.stored, row.currency),
      calculatedBalance: toMoney(row.calculated, row.currency),
      checkedEntries: Number(row.entries),
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const affected = await run(
      this.em,
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        nullable(message.processedAt),
      ],
    );
    return affected === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .select("*")
      .where({ consumerName, messageId })
      .execute<InboxMessageRow | undefined>("get");
    return row ? toInboxMessage(row) : undefined;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await run(
      this.em,
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
      [nullable(message.processedAt), message.consumerName, message.messageId],
    );
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await run(
      this.em,
      `insert into outbox_messages (
         id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
       ) values (?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        nullable(message.nextAttemptAt),
        nullable(message.publishedAt),
      ],
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxMessageRow[]>(
      `select id, aggregate_id as "aggregateId", event_type as "eventType", payload,
              occurred_at as "occurredAt", attempts, next_attempt_at as "nextAttemptAt",
              published_at as "publishedAt"
         from outbox_messages
        where published_at is null
          and (next_attempt_at is null or next_attempt_at <= ?)
        order by occurred_at, id
        limit ?
          for update skip locked`,
      [now, limit],
    );
    return rows.map(toOutboxMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    await run(
      this.em,
      `update outbox_messages set attempts = ?, next_attempt_at = ?, published_at = ? where id = ?`,
      [message.attempts, nullable(message.nextAttemptAt), nullable(message.publishedAt), message.id],
    );
  }
}

export function createTransactionContext(em: SqlEntityManager): TransactionContext {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
