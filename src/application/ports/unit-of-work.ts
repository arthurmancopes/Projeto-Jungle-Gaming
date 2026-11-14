import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./repositories";

/** Repositórios ligados a UMA transação SQL. */
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Executa o trabalho em uma única transação SQL: commit se a função retornar,
 * rollback se lançar. Falhas temporárias viram TransientInfrastructureError.
 */
export interface UnitOfWork {
  run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}
