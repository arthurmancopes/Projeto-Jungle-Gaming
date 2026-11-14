import { describe, expect, test } from "bun:test";
import {
  FailureCode,
  InvalidTransactionError,
  InvalidTransactionStateError,
} from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction";
import { NOW, brl, makeTx } from "./helpers";

describe("WagerTransaction — criação", () => {
  test("nasce em PENDING", () => {
    const tx = makeTx(Kind.Bet, "25.00");
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  test.each([[Kind.Refund], [Kind.Rollback]])("%s exige referência", (kind) => {
    expect(() => makeTx(kind, "25.00")).toThrow(InvalidTransactionError);
    expect(makeTx(kind, "25.00", { referenceExternalTransactionId: "bet-1" }).requiresReference()).toBe(true);
  });

  test("OPENING não pode ser criado pela factory pública", () => {
    expect(() => makeTx(Kind.Opening, "25.00")).toThrow(InvalidTransactionError);
  });

  test("BET não aceita referência, e ninguém referencia a si mesmo", () => {
    expect(() => makeTx(Kind.Bet, "1.00", { referenceExternalTransactionId: "x" })).toThrow(
      InvalidTransactionError,
    );
    expect(() =>
      makeTx(Kind.Refund, "1.00", { externalTransactionId: "same", referenceExternalTransactionId: "same" }),
    ).toThrow(InvalidTransactionError);
  });

  test("valor zero só é aceito em LOSS", () => {
    expect(() => makeTx(Kind.Bet, "0.00")).toThrow(InvalidTransactionError);
    expect(() => makeTx(Kind.Win, "0.00")).toThrow(InvalidTransactionError);
    expect(makeTx(Kind.Loss, "0.00").affectsBalance()).toBe(false);
  });

  test("createOpening gera transação interna", () => {
    const tx = WagerTransaction.createOpening({
      id: "tx-open",
      walletId: "wallet-1",
      playerId: "player-1",
      payloadHash: "hash",
      money: brl("10.00"),
      now: NOW,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe("internal");
    expect(tx.idempotencyKey).toBe("opening:wallet-1");
  });
});

describe("WagerTransaction — transições", () => {
  const terminalBuilders: Array<[string, () => WagerTransaction]> = [
    [
      "PROCESSED",
      () => {
        const tx = makeTx(Kind.Bet, "1.00");
        tx.markProcessed({ observedBalance: brl("9.00"), at: NOW });
        return tx;
      },
    ],
    [
      "REJECTED",
      () => {
        const tx = makeTx(Kind.Bet, "1.00");
        tx.reject(FailureCode.InsufficientFunds, { observedBalance: brl("0.00"), at: NOW });
        return tx;
      },
    ],
    [
      "FAILED",
      () => {
        const tx = makeTx(Kind.Bet, "1.00");
        tx.fail(FailureCode.WalletNotFound, { at: NOW });
        return tx;
      },
    ],
  ];

  test.each(terminalBuilders)("%s é terminal: qualquer transição lança", (_name, build) => {
    const tx = build();
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toEqual(NOW);
    expect(() => tx.markProcessed({ observedBalance: brl("1.00"), at: NOW })).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.AlreadyReversed, { at: NOW })).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.AlreadyReversed, { at: NOW })).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => tx.scheduleReferenceRetry(NOW)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING -> PENDING_REFERENCE -> PROCESSED", () => {
    const tx = makeTx(Kind.Refund, "1.00", { referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(NOW);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextReferenceAttemptAt).toEqual(NOW);

    tx.scheduleReferenceRetry(NOW);
    expect(tx.referenceAttempts).toBe(1);

    tx.markProcessed({ referenceTransactionId: "tx-bet", observedBalance: brl("1.00"), at: NOW });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("tx-bet");
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test("rejeição guarda failureCode e saldo observado", () => {
    const tx = makeTx(Kind.Bet, "1.00");
    tx.reject(FailureCode.InsufficientFunds, { observedBalance: brl("0.50"), at: NOW });
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance?.amount).toBe("0.50");
  });

  test("rehydrate reconstrói estado terminal sem revalidar", () => {
    const tx = WagerTransaction.rehydrate({
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game",
      kind: Kind.Bet,
      money: brl("1.00"),
      createdAt: NOW,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      referenceAttempts: 0,
    });
    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe("WagerTransaction — consultas", () => {
  test("idempotency key com payload divergente é detectada por matchesPayload", () => {
    const tx = makeTx(Kind.Bet, "25.00", { payloadHash: "aaa" });
    expect(tx.matchesPayload("aaa")).toBe(true);
    expect(tx.matchesPayload("bbb")).toBe(false);
  });

  test("direção do lançamento por kind", () => {
    const bet = makeTx(Kind.Bet, "1.00");
    const win = makeTx(Kind.Win, "1.00");
    const refund = makeTx(Kind.Refund, "1.00", { referenceExternalTransactionId: "b" });
    const rollback = makeTx(Kind.Rollback, "1.00", { referenceExternalTransactionId: "b" });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow();
    expect(() => makeTx(Kind.Loss, "1.00").ledgerDirectionFor()).toThrow();
  });

  test("resolvesReference: REFUND/ROLLBACK sempre, WIN só quando informada", () => {
    expect(makeTx(Kind.Win, "1.00").resolvesReference()).toBe(false);
    expect(makeTx(Kind.Win, "1.00", { referenceExternalTransactionId: "b" }).resolvesReference()).toBe(true);
    expect(makeTx(Kind.Loss, "1.00", { referenceExternalTransactionId: "b" }).resolvesReference()).toBe(false);
  });
});
