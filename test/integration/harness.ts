import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWalletUseCase, type WalletView } from "../../src/application/create-wallet.use-case";
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
} from "../../src/application/submit-wager-transaction.use-case";
import { WagerProcessor } from "../../src/application/wager-processor";
import config from "../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { SystemClock, UuidV7Generator } from "../../src/infrastructure/system";

/**
 * Testes de integração usam o PostgreSQL real do Docker Compose
 * (bun run infra:up && bun run migration:up). Nenhum mock de banco.
 * Cada teste cria suas próprias wallets, então não há limpeza entre testes
 * (o ledger, aliás, nem permite DELETE).
 */
export interface Harness {
  orm: MikroORM;
  createWallet: CreateWalletUseCase;
  submit: SubmitWagerTransactionUseCase;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const orm = await MikroORM.init(config);
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  const uow = new MikroOrmUnitOfWork(orm);
  const processor = new WagerProcessor(ids, clock);
  return {
    orm,
    createWallet: new CreateWalletUseCase(uow, ids, clock),
    submit: new SubmitWagerTransactionUseCase(uow, processor, ids, clock),
    close: () => orm.close(true),
  };
}

export const uuid = () => Bun.randomUUIDv7();

export function openWallet(h: Harness, amount: string): Promise<WalletView> {
  return h.createWallet.execute({
    playerId: uuid(),
    initialBalance: { amount, currency: "BRL" },
    correlationId: uuid(),
  });
}

/** Monta um comando válido; por padrão cada chamada gera um externalTransactionId novo. */
export function command(
  wallet: WalletView,
  kind: string,
  amount: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${uuid()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: "provider-a",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    correlationId: uuid(),
    ...overrides,
  };
}

export async function sql<T = Record<string, unknown>>(h: Harness, query: string, params: unknown[] = []): Promise<T[]> {
  return h.orm.em.fork().execute(query, params) as Promise<T[]>;
}

export interface WalletSnapshot {
  balance: string;
  version: number;
  ledgerBalance: string;
  entries: number;
  debits: number;
  credits: number;
}

/** Lê o saldo materializado e o saldo reconstruído pelo ledger (calculado no banco, em numeric). */
export async function snapshot(h: Harness, walletId: string): Promise<WalletSnapshot> {
  const [row] = await sql<{
    balance: string;
    version: number;
    ledger_balance: string;
    entries: string;
    debits: string;
    credits: string;
  }>(
    h,
    `select w.balance::text as balance,
            w.version,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger_balance,
            count(l.id)::text as entries,
            count(l.id) filter (where l.direction = 'DEBIT')::text as debits,
            count(l.id) filter (where l.direction = 'CREDIT')::text as credits
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ?
      group by w.id`,
    [walletId],
  );
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return {
    balance: row.balance,
    version: Number(row.version),
    ledgerBalance: row.ledger_balance,
    entries: Number(row.entries),
    debits: Number(row.debits),
    credits: Number(row.credits),
  };
}

/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectConsistent(h: Harness, walletId: string): Promise<WalletSnapshot> {
  const snap = await snapshot(h, walletId);
  if (snap.balance !== snap.ledgerBalance) {
    throw new Error(`wallet ${walletId} inconsistent: balance ${snap.balance} != ledger ${snap.ledgerBalance}`);
  }
  return snap;
}
