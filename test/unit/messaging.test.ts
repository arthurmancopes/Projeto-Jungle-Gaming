import { describe, expect, test } from "bun:test";
import { FailureCode, InvariantViolationError } from "../../src/domain/errors";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from "../../src/domain/events";
import { InboxMessage } from "../../src/domain/inbox-message";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "../../src/domain/wager-transaction";
import { NOW, apply, makeTx, nextId, openWallet } from "./helpers";

const ctx = (): EventContext => ({
  eventId: nextId("event"),
  correlationId: "corr-1",
  causationId: "cause-1",
  occurredAt: NOW,
});

describe("Eventos de integração", () => {
  test("WalletBalanceChanged carrega MoneyProps (strings), nunca Money", () => {
    const wallet = openWallet("100.00");
    const bet = makeTx(Kind.Bet, "25.00");
    const outcome = apply(wallet, bet);
    if (outcome.status !== Status.Processed || !outcome.entry) throw new Error("expected entry");

    const event = WalletBalanceChanged.from(wallet, outcome.entry, ctx());
    const json = event.toJSON();

    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(wallet.id);
    expect(json.occurredAt).toBe("2026-07-29T15:00:00.000Z");
    expect(json.data).toEqual({
      walletId: wallet.id,
      transactionId: bet.id,
      direction: LedgerDirection.Debit,
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
    // O envelope sobrevive a um round-trip JSON sem perder informação.
    expect(JSON.parse(JSON.stringify(event))).toEqual(json);
  });

  test("WagerTransactionProcessed inclui LOSS, com o saldo inalterado", () => {
    const wallet = openWallet("100.00");
    const loss = makeTx(Kind.Loss, "25.00");
    apply(wallet, loss);
    const json = WagerTransactionProcessed.from(loss, ctx()).toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.data.kind).toBe(Kind.Loss);
    expect(json.data.balance).toEqual({ amount: "100.00", currency: "BRL" });
  });

  test("WagerTransactionRejected carrega o failureCode", () => {
    const wallet = openWallet("1.00");
    const bet = makeTx(Kind.Bet, "25.00");
    apply(wallet, bet);
    const json = WagerTransactionRejected.from(bet, ctx()).toJSON();
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("WagerTransactionPendingReference carrega a referência e a próxima tentativa", () => {
    const wallet = openWallet("1.00");
    const refund = makeTx(Kind.Refund, "25.00", { referenceExternalTransactionId: "bet-x" });
    apply(wallet, refund);
    const json = WagerTransactionPendingReference.from(refund, ctx()).toJSON();
    expect(json.data.referenceExternalTransactionId).toBe("bet-x");
    expect(json.data.nextAttemptAt).toBe("2026-07-29T15:00:01.000Z");
  });

  test("evento incompatível com o estado da transação é erro de programação", () => {
    const pending = makeTx(Kind.Bet, "1.00");
    expect(() => WagerTransactionProcessed.from(pending, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(pending, ctx())).toThrow(InvariantViolationError);
  });
});

describe("OutboxMessage", () => {
  const enqueue = () => {
    const wallet = openWallet("100.00");
    const loss = makeTx(Kind.Loss, "1.00");
    apply(wallet, loss);
    const event = WagerTransactionProcessed.from(loss, ctx());
    return { event, message: OutboxMessage.enqueue(event) };
  };

  test("enqueue grava o envelope serializado e usa o eventId como id", () => {
    const { event, message } = enqueue();
    expect(message.id).toBe(event.eventId);
    expect(message.eventType).toBe("WagerTransactionProcessed");
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(event)));
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.attempts).toBe(0);
  });

  test("scheduleRetry incrementa attempts e aplica backoff", () => {
    const { message } = enqueue();
    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(NOW.getTime() + 2000));
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 2000))).toBe(true);

    for (let i = 0; i < 20; i++) message.scheduleRetry(NOW);
    expect(message.nextAttemptAt).toEqual(new Date(NOW.getTime() + 300_000));
  });

  test("markPublished encerra a mensagem; nova transição é erro", () => {
    const { message } = enqueue();
    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow(InvariantViolationError);
    expect(() => message.scheduleRetry(NOW)).toThrow(InvariantViolationError);
  });
});

describe("InboxMessage", () => {
  const receive = () =>
    InboxMessage.receive({ messageId: "msg-1", consumerName: "wager-consumer", payloadHash: "aaa", receivedAt: NOW });

  test("recebe, marca como processada uma única vez", () => {
    const message = receive();
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(NOW);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(NOW);
    expect(() => message.markProcessed(NOW)).toThrow(InvariantViolationError);
  });

  test("detecta mesmo messageId com payload diferente", () => {
    expect(receive().matchesPayload("aaa")).toBe(true);
    expect(receive().matchesPayload("bbb")).toBe(false);
  });
});
