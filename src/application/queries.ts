import type { WalletLedgerEntry } from "../domain/ledger-entry";
import type { MoneyProps } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { WalletView } from "./create-wallet.use-case";
import { NotFoundError, ValidationError } from "./errors";
import type { UnitOfWork } from "./ports/unit-of-work";

// ------------------------------------------------------------------ wallet

export class GetWalletQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    assertUuid("walletId", walletId);
    const wallet = await this.uow.run((ctx) => ctx.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError(`Wallet ${walletId}`);
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}

// ------------------------------------------------------------- transaction

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  /** Saldo da wallet observado quando a transação foi concluída. */
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

function toTransactionView(tx: WagerTransaction): WagerTransactionView {
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
    status: tx.status,
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
    ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.observedBalance !== undefined ? { balance: tx.observedBalance.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt !== undefined ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

export class GetWagerTransactionQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    assertUuid("transactionId", transactionId);
    const tx = await this.uow.run((ctx) => ctx.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError(`Transaction ${transactionId}`);
    return toTransactionView(tx);
  }

  async byProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.run((ctx) =>
      ctx.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (!tx) throw new NotFoundError(`Transaction ${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }
}

// ------------------------------------------------------------------ ledger

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Cursor opaco da próxima página, ou null quando não há mais lançamentos. */
  nextCursor: string | null;
}

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;
const CURSOR_PREFIX = "v1:";

/** O cursor é a posição (seq) do último item entregue: estável mesmo com inserções concorrentes. */
export function encodeLedgerCursor(seq: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${seq}`, "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const seq = decoded.startsWith(CURSOR_PREFIX) ? decoded.slice(CURSOR_PREFIX.length) : "";
  if (!/^\d{1,18}$/.test(seq)) {
    throw new ValidationError("invalid cursor");
  }
  return seq;
}

function toLedgerView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export class ListLedgerQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, options: { cursor?: string; limit?: number } = {}): Promise<LedgerPage> {
    assertUuid("walletId", walletId);
    const limit = options.limit ?? LEDGER_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${LEDGER_MAX_LIMIT}`);
    }
    const afterSeq = options.cursor !== undefined ? decodeLedgerCursor(options.cursor) : undefined;

    return this.uow.run(async (ctx) => {
      if (!(await ctx.wallets.findById(walletId))) {
        throw new NotFoundError(`Wallet ${walletId}`);
      }
      // Busca um a mais para saber se existe próxima página sem uma segunda consulta.
      const rows = await ctx.ledger.listByWallet(walletId, afterSeq, limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((item) => toLedgerView(item.entry)),
        nextCursor: rows.length > limit && last ? encodeLedgerCursor(last.seq) : null,
      };
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Id que não é UUID nunca existe: responde 404 em vez de deixar o banco falhar no cast. */
function assertUuid(name: string, value: string): void {
  if (!UUID.test(value)) {
    throw new NotFoundError(`${name} ${value}`);
  }
}
