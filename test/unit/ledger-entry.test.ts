import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../src/domain/errors";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/ledger-entry";
import { NOW, brl } from "./helpers";

const base = {
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  createdAt: NOW,
};

describe("WalletLedgerEntry", () => {
  test("crédito balanceado", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("25.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("125.00"),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test("débito balanceado", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("25.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("75.00"),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test("rejeita aritmética incorreta", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("25.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("80.00"),
      }),
    ).toThrow(InvariantViolationError);
  });

  test("rejeita valor zero e saldo negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl("0.00"),
        balanceBefore: brl("1.00"),
        balanceAfter: brl("1.00"),
      }),
    ).toThrow(InvariantViolationError);

    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("5.00"),
        balanceBefore: brl("1.00"),
        balanceAfter: brl("1.00").subtract(brl("5.00")),
      }),
    ).toThrow(InvariantViolationError);
  });

  test("é estruturalmente imutável", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("1.00"),
      balanceBefore: brl("0.00"),
      balanceAfter: brl("1.00"),
    });
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test("rehydrate não revalida", () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl("1.00"),
      balanceBefore: brl("0.00"),
      balanceAfter: brl("9.00"),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
