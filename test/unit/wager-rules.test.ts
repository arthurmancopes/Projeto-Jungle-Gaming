import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import { MAX_REFERENCE_ATTEMPTS, referenceRetryDelaySeconds } from "../../src/domain/wager-rules";
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "../../src/domain/wager-transaction";
import { apply, makeTx, openWallet, processed, reversal, usd } from "./helpers";

function expectRejected(outcome: ReturnType<typeof apply>, code: FailureCode) {
  expect(outcome).toEqual({ status: Status.Rejected, failureCode: code });
}

describe("BET", () => {
  test("debita o saldo e gera 1 lançamento DEBIT", () => {
    const wallet = openWallet("1000.00");
    const bet = makeTx(Kind.Bet, "25.00");
    const outcome = apply(wallet, bet);

    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error("unreachable");
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(outcome.entry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("975.00");
    expect(wallet.version).toBe(2);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.observedBalance?.amount).toBe("975.00");
  });

  test("saldo insuficiente: REJECTED, sem lançamento, saldo e version intactos", () => {
    const wallet = openWallet("10.00");
    const bet = makeTx(Kind.Bet, "10.01");
    expectRejected(apply(wallet, bet), FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe("10.00");
    expect(wallet.version).toBe(1);
    expect(bet.observedBalance?.amount).toBe("10.00");
  });

  test("cenário obrigatório: 100.00 e duas apostas de 80.00", () => {
    const wallet = openWallet("100.00");
    const first = apply(wallet, makeTx(Kind.Bet, "80.00"));
    const second = apply(wallet, makeTx(Kind.Bet, "80.00"));
    expect(first.status).toBe(Status.Processed);
    expectRejected(second, FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe("20.00");
  });
});

describe("WIN", () => {
  test("credita o saldo sem referência", () => {
    const wallet = openWallet("0.00");
    const outcome = apply(wallet, makeTx(Kind.Win, "50.00"));
    expect(outcome.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe("50.00");
  });

  test("com referência a uma BET da mesma rodada", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, Kind.Bet, "10.00");
    const win = reversal(Kind.Win, "35.00", bet);
    expect(apply(wallet, win, bet).status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe("125.00");
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("referência que não é BET é rejeitada", () => {
    const wallet = openWallet("100.00");
    const otherWin = processed(wallet, Kind.Win, "10.00");
    expectRejected(apply(wallet, reversal(Kind.Win, "5.00", otherWin), otherWin), FailureCode.InvalidReferenceKind);
  });
});

describe("LOSS", () => {
  test("é PROCESSED sem lançamento e sem mexer em saldo ou version", () => {
    const wallet = openWallet("100.00");
    const loss = makeTx(Kind.Loss, "25.00");
    const outcome = apply(wallet, loss);
    expect(outcome).toEqual({ status: Status.Processed });
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(loss.observedBalance?.amount).toBe("100.00");
  });
});

describe("REFUND", () => {
  test("credita de volta uma BET PROCESSED", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, Kind.Bet, "40.00");
    const refund = reversal(Kind.Refund, "40.00", bet);
    const outcome = apply(wallet, refund, bet);
    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error("unreachable");
    expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test("só referencia BET", () => {
    const wallet = openWallet("100.00");
    const win = processed(wallet, Kind.Win, "40.00");
    expectRejected(apply(wallet, reversal(Kind.Refund, "40.00", win), win), FailureCode.InvalidReferenceKind);
  });

  test("valor diferente da referência é rejeitado", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, Kind.Bet, "40.00");
    expectRejected(apply(wallet, reversal(Kind.Refund, "39.99", bet), bet), FailureCode.AmountMismatch);
    expect(wallet.balance.amount).toBe("60.00");
  });

  test("referência já revertida é rejeitada", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, Kind.Bet, "40.00");
    expectRejected(apply(wallet, reversal(Kind.Refund, "40.00", bet), bet, true), FailureCode.AlreadyReversed);
    expect(wallet.balance.amount).toBe("60.00");
  });

  test("referência de outra rodada é rejeitada", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, Kind.Bet, "40.00");
    const refund = reversal(Kind.Refund, "40.00", bet, { roundId: "round-2" });
    expectRejected(apply(wallet, refund, bet), FailureCode.ReferenceMismatch);
  });

  test("referência REJECTED não pode ser revertida", () => {
    const wallet = openWallet("10.00");
    const bet = processed(wallet, Kind.Bet, "40.00"); // rejeitada por saldo
    expect(bet.status).toBe(Status.Rejected);
    expectRejected(apply(wallet, reversal(Kind.Refund, "40.00", bet), bet), FailureCode.ReferenceNotProcessed);
    expect(wallet.balance.amount).toBe("10.00");
  });
});

describe("ROLLBACK", () => {
  test("de BET: crédito", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, Kind.Bet, "40.00");
    const outcome = apply(wallet, reversal(Kind.Rollback, "40.00", bet), bet);
    if (outcome.status !== Status.Processed) throw new Error("expected PROCESSED");
    expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("de WIN: débito", () => {
    const wallet = openWallet("100.00");
    const win = processed(wallet, Kind.Win, "40.00");
    const outcome = apply(wallet, reversal(Kind.Rollback, "40.00", win), win);
    if (outcome.status !== Status.Processed) throw new Error("expected PROCESSED");
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("de REFUND: débito", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, Kind.Bet, "40.00");
    const refund = reversal(Kind.Refund, "40.00", bet);
    apply(wallet, refund, bet);
    const outcome = apply(wallet, reversal(Kind.Rollback, "40.00", refund), refund);
    if (outcome.status !== Status.Processed) throw new Error("expected PROCESSED");
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("60.00");
  });

  test("que negativaria o saldo: REVERSAL_WOULD_OVERDRAW (distinto de INSUFFICIENT_FUNDS)", () => {
    const wallet = openWallet("0.00");
    const win = processed(wallet, Kind.Win, "40.00");
    apply(wallet, makeTx(Kind.Bet, "30.00")); // jogador já gastou parte do prêmio
    const rollback = reversal(Kind.Rollback, "40.00", win);
    expectRejected(apply(wallet, rollback, win), FailureCode.ReversalWouldOverdraw);
    expect(wallet.balance.amount).toBe("10.00");
    expect(rollback.status).toBe(Status.Rejected);
  });

  test("não reverte LOSS", () => {
    const wallet = openWallet("100.00");
    const loss = processed(wallet, Kind.Loss, "40.00");
    expectRejected(apply(wallet, reversal(Kind.Rollback, "40.00", loss), loss), FailureCode.InvalidReferenceKind);
  });
});

describe("Referência fora de ordem", () => {
  test("referência ausente: PENDING_REFERENCE, sem tocar no saldo", () => {
    const wallet = openWallet("100.00");
    const rollback = makeTx(Kind.Rollback, "40.00", { referenceExternalTransactionId: "bet-futura" });
    expect(apply(wallet, rollback)).toEqual({ status: Status.PendingReference });
    expect(rollback.status).toBe(Status.PendingReference);
    expect(rollback.nextReferenceAttemptAt).toBeDefined();
    expect(wallet.version).toBe(1);
  });

  test("quando a referência chega, o reprocessamento aplica a reversão", () => {
    const wallet = openWallet("100.00");
    const refund = makeTx(Kind.Refund, "40.00", { referenceExternalTransactionId: "bet-late" });
    apply(wallet, refund);

    const bet = makeTx(Kind.Bet, "40.00", { externalTransactionId: "bet-late" });
    apply(wallet, bet);
    expect(wallet.balance.amount).toBe("60.00");

    expect(apply(wallet, refund, bet).status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("esgotado o limite de tentativas: REJECTED com REFERENCE_NOT_FOUND", () => {
    const wallet = openWallet("100.00");
    const refund = makeTx(Kind.Refund, "40.00", { referenceExternalTransactionId: "nunca-chega" });
    apply(wallet, refund);

    for (let attempt = 1; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      expect(apply(wallet, refund)).toEqual({ status: Status.PendingReference });
      expect(refund.referenceAttempts).toBe(attempt);
    }
    expectRejected(apply(wallet, refund), FailureCode.ReferenceNotFound);
    expect(refund.isTerminal()).toBe(true);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("backoff exponencial com teto", () => {
    expect([0, 1, 2, 3, 6, 10].map(referenceRetryDelaySeconds)).toEqual([1, 2, 4, 8, 60, 60]);
  });
});

describe("Conflito de moeda", () => {
  test("operação em moeda diferente da wallet é REJECTED", () => {
    const wallet = openWallet("100.00");
    const bet = makeTx(Kind.Bet, "10.00", { money: usd("10.00") });
    expectRejected(apply(wallet, bet), FailureCode.CurrencyMismatch);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });
});
