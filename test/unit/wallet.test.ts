import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvariantViolationError,
} from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import { Wallet } from "../../src/domain/wallet";
import { NOW, PLAYER_ID, WALLET_ID, brl, nextId, openWallet, usd } from "./helpers";

const movement = (amount: string) => ({
  entryId: nextId("entry"),
  transactionId: nextId("tx"),
  money: brl(amount),
  at: new Date(NOW.getTime() + 1000),
});

describe("Wallet — abertura", () => {
  test("abre com version 1 e lançamento CREDIT de abertura", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl("1000.00"),
      openingEntryId: "entry-open",
      openingTransactionId: "tx-open",
      now: NOW,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("1000.00");
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe("tx-open");
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("1000.00");
  });

  test("saldo inicial zero não gera lançamento", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl("0.00"),
      openingEntryId: "entry-open",
      openingTransactionId: "tx-open",
      now: NOW,
    });
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test("saldo inicial negativo é rejeitado", () => {
    expect(() =>
      Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        initialBalance: brl("0.00").subtract(brl("1.00")),
        openingEntryId: "entry-open",
        openingTransactionId: "tx-open",
        now: NOW,
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe("Wallet — movimentações", () => {
  test("debit reduz o saldo, incrementa version e devolve o lançamento", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(movement("30.00"));
    expect(wallet.balance.amount).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(entry.createdAt);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("70.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("credit aumenta o saldo e incrementa version", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit(movement("0.01"));
    expect(wallet.balance.amount).toBe("100.01");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("pode debitar exatamente o saldo inteiro", () => {
    const wallet = openWallet("100.00");
    wallet.debit(movement("100.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("saldo nunca fica negativo: débito acima do saldo lança e não altera nada", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.debit(movement("100.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("moeda diferente da wallet é rejeitada", () => {
    const wallet = openWallet("100.00");
    const foreign = { ...movement("1.00"), money: usd("1.00") };
    expect(() => wallet.credit(foreign)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(foreign)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("movimentação de valor zero é rejeitada", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.credit(movement("0.00"))).toThrow(InvariantViolationError);
    expect(() => wallet.debit(movement("0.00"))).toThrow(InvariantViolationError);
  });

  test("saldo final é igual ao reconstruído pelos lançamentos", () => {
    const wallet = openWallet("0.00");
    const entries = [
      wallet.credit(movement("50.00")),
      wallet.debit(movement("20.00")),
      wallet.credit(movement("0.05")),
      wallet.debit(movement("30.05")),
    ];
    const rebuilt = entries.reduce(
      (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
      brl("0.00"),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(5);
  });

  test("rehydrate reconstrói o estado sem alterar version", () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe("42.00");
  });
});
