import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from "../../src/domain/wager-transaction";
import { applyWagerTransaction, type WagerOutcome } from "../../src/domain/wager-rules";

export const NOW = new Date("2026-07-29T15:00:00.000Z");
export const WALLET_ID = "wallet-1";
export const PLAYER_ID = "player-1";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });

let sequence = 0;
export const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export function openWallet(initial: string): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: brl(initial),
    openingEntryId: nextId("entry"),
    openingTransactionId: nextId("tx"),
    now: NOW,
  }).wallet;
}

export function makeTx(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  return WagerTransaction.create({
    id: nextId("tx"),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: "hash",
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    now: NOW,
    ...overrides,
  });
}

export function apply(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
): WagerOutcome {
  return applyWagerTransaction({
    wallet,
    transaction,
    reference,
    referenceAlreadyReversed,
    ledgerEntryId: nextId("entry"),
    now: NOW,
  });
}

/** Cria e aplica uma transação, devolvendo-a já em estado final (para servir de referência). */
export function processed(wallet: Wallet, kind: WagerTransactionKind, amount: string): WagerTransaction {
  const tx = makeTx(kind, amount);
  apply(wallet, tx);
  return tx;
}

export function reversal(
  kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback | WagerTransactionKind.Win,
  amount: string,
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return makeTx(kind, amount, {
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}
