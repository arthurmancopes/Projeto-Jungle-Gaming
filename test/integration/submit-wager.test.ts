import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DuplicateWalletError, IdempotencyConflictError, WalletNotFoundError } from "../../src/application/errors";
import { FailureCode, InvalidMoneyError, InvalidTransactionError } from "../../src/domain/errors";
import { command, createHarness, expectConsistent, openWallet, snapshot, sql, uuid, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const outboxTypes = async (transactionId: string) =>
  (
    await sql<{ event_type: string }>(
      h,
      `select event_type from outbox_messages where payload->>'causationId' = ? order by event_type`,
      [transactionId],
    )
  ).map((r) => r.event_type);

describe("Criação de wallet", () => {
  test("saldo inicial gera OPENING + lançamento CREDIT na mesma transação, version 1", async () => {
    const wallet = await openWallet(h, "1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance).toEqual({ amount: "1000.00", currency: "BRL" });

    const snap = await expectConsistent(h, wallet.id);
    expect(snap).toMatchObject({ balance: "1000.00", version: 1, entries: 1, credits: 1 });

    const [opening] = await sql<{ kind: string; status: string }>(
      h,
      `select kind, status from wager_transactions where wallet_id = ?`,
      [wallet.id],
    );
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED" });
  });

  test("saldo inicial zero não gera transação nem lançamento", async () => {
    const wallet = await openWallet(h, "0.00");
    const snap = await expectConsistent(h, wallet.id);
    expect(snap).toMatchObject({ balance: "0.00", version: 1, entries: 0 });
  });

  test("wallet duplicada para o mesmo playerId + currency é conflito", async () => {
    const playerId = uuid();
    const create = () =>
      h.createWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "BRL" }, correlationId: uuid() });
    await create();
    await expect(create()).rejects.toBeInstanceOf(DuplicateWalletError);
  });
});

describe("Submissão e atomicidade", () => {
  test("BET processada: saldo, ledger, transação e outbox gravados juntos", async () => {
    const wallet = await openWallet(h, "1000.00");
    const result = await h.submit.execute(command(wallet, "BET", "25.00"));

    expect(result).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const snap = await expectConsistent(h, wallet.id);
    expect(snap).toMatchObject({ balance: "975.00", version: 2, debits: 1 });
    expect(await outboxTypes(result.transactionId)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("BET rejeitada: sem lançamento, sem mudança de saldo, só o evento de rejeição", async () => {
    const wallet = await openWallet(h, "10.00");
    const result = await h.submit.execute(command(wallet, "BET", "10.01"));

    expect(result).toMatchObject({ status: "REJECTED", failureCode: FailureCode.InsufficientFunds });
    const snap = await expectConsistent(h, wallet.id);
    expect(snap).toMatchObject({ balance: "10.00", version: 1, debits: 0 });
    expect(await outboxTypes(result.transactionId)).toEqual(["WagerTransactionRejected"]);
  });

  test("LOSS: PROCESSED sem lançamento e sem WalletBalanceChanged", async () => {
    const wallet = await openWallet(h, "10.00");
    const result = await h.submit.execute(command(wallet, "LOSS", "5.00"));

    expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "10.00", currency: "BRL" } });
    expect(await snapshot(h, wallet.id)).toMatchObject({ balance: "10.00", version: 1, entries: 1 });
    expect(await outboxTypes(result.transactionId)).toEqual(["WagerTransactionProcessed"]);
  });

  test("payload inválido não toca o banco", async () => {
    const wallet = await openWallet(h, "10.00");
    await expect(h.submit.execute(command(wallet, "OPENING", "5.00"))).rejects.toBeInstanceOf(InvalidTransactionError);
    await expect(h.submit.execute(command(wallet, "BET", "5.001"))).rejects.toBeInstanceOf(InvalidMoneyError);
    await expect(h.submit.execute(command(wallet, "REFUND", "5.00"))).rejects.toBeInstanceOf(InvalidTransactionError);
    expect(await sql(h, `select 1 from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [wallet.id])).toHaveLength(0);
  });

  test("wallet inexistente ou de outro player", async () => {
    const wallet = await openWallet(h, "10.00");
    await expect(h.submit.execute(command({ ...wallet, id: uuid() }, "BET", "1.00"))).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    await expect(h.submit.execute(command({ ...wallet, playerId: uuid() }, "BET", "1.00"))).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });

  test("moeda diferente da wallet: REJECTED com CURRENCY_MISMATCH", async () => {
    const wallet = await openWallet(h, "10.00");
    const result = await h.submit.execute(
      command(wallet, "BET", "1.00", { money: { amount: "1.00", currency: "USD" } }),
    );
    expect(result).toMatchObject({ status: "REJECTED", failureCode: FailureCode.CurrencyMismatch });
    await expectConsistent(h, wallet.id);
  });
});

describe("Idempotência persistente", () => {
  test("replay devolve o resultado original, com o saldo observado naquele momento", async () => {
    const wallet = await openWallet(h, "100.00");
    const bet = command(wallet, "BET", "30.00");

    const first = await h.submit.execute(bet);
    await h.submit.execute(command(wallet, "WIN", "500.00")); // o saldo muda depois
    const replay = await h.submit.execute({ ...bet, correlationId: uuid() });

    expect(first.balance.amount).toBe("70.00");
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "570.00", debits: 1 });
  });

  test("replay de transação rejeitada devolve a mesma rejeição", async () => {
    const wallet = await openWallet(h, "1.00");
    const bet = command(wallet, "BET", "30.00");
    const first = await h.submit.execute(bet);
    await h.submit.execute(command(wallet, "WIN", "500.00"));
    const replay = await h.submit.execute(bet);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(String(replay.status)).toBe("REJECTED");
  });

  test("mesma key com payload diferente é conflito, não replay", async () => {
    const wallet = await openWallet(h, "100.00");
    const bet = command(wallet, "BET", "30.00");
    await h.submit.execute(bet);

    await expect(h.submit.execute({ ...bet, money: { amount: "31.00", currency: "BRL" } })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "70.00", debits: 1 });
  });

  test("mesmo (providerId, externalTransactionId) com outra key é conflito", async () => {
    const wallet = await openWallet(h, "100.00");
    const bet = command(wallet, "BET", "30.00");
    await h.submit.execute(bet);
    await expect(h.submit.execute({ ...bet, idempotencyKey: `outra-${uuid()}` })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "70.00", debits: 1 });
  });
});

describe("Reversões", () => {
  test("REFUND de BET e segunda reversão rejeitada", async () => {
    const wallet = await openWallet(h, "100.00");
    const bet = command(wallet, "BET", "40.00");
    await h.submit.execute(bet);

    const refund = await h.submit.execute(
      command(wallet, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00", currency: "BRL" } });

    const again = await h.submit.execute(
      command(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(again).toMatchObject({ status: "REJECTED", failureCode: FailureCode.AlreadyReversed });
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "100.00", debits: 1, credits: 2 });
  });

  test("ROLLBACK de WIN que negativaria o saldo: REVERSAL_WOULD_OVERDRAW", async () => {
    const wallet = await openWallet(h, "0.00");
    const win = command(wallet, "WIN", "40.00");
    await h.submit.execute(win);
    await h.submit.execute(command(wallet, "BET", "30.00"));

    const rollback = await h.submit.execute(
      command(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: "REJECTED", failureCode: FailureCode.ReversalWouldOverdraw });
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "10.00" });
  });

  test("REFUND antes da BET fica PENDING_REFERENCE, sem tocar no saldo", async () => {
    const wallet = await openWallet(h, "100.00");
    const result = await h.submit.execute(
      command(wallet, "REFUND", "40.00", { referenceExternalTransactionId: `bet-${uuid()}` }),
    );
    expect(result).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "100.00", currency: "BRL" } });
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "100.00", version: 1, entries: 1 });
    expect(await outboxTypes(result.transactionId)).toEqual(["WagerTransactionPendingReference"]);
  });
});

describe("Inbox", () => {
  test("a mesma mensagem entregue duas vezes produz um único efeito", async () => {
    const wallet = await openWallet(h, "100.00");
    const message = command(wallet, "BET", "10.00", {
      inbox: { consumerName: "wager-consumer", messageId: `msg-${uuid()}` },
    });

    const first = await h.submit.execute(message);
    const redelivery = await h.submit.execute(message);

    expect(first.idempotentReplay).toBe(false);
    expect(redelivery).toEqual({ ...first, idempotentReplay: true });
    expect(await expectConsistent(h, wallet.id)).toMatchObject({ balance: "90.00", debits: 1 });

    const [inbox] = await sql<{ processed_at: unknown }>(
      h,
      `select processed_at from inbox_messages where message_id = ?`,
      [message.inbox?.messageId],
    );
    expect(inbox?.processed_at).not.toBeNull();
  });
});

describe("Constraints do schema (garantias no banco, não só na aplicação)", () => {
  test("ledger é append-only: UPDATE e DELETE falham", async () => {
    const wallet = await openWallet(h, "10.00");
    await expect(sql(h, `update wallet_ledger_entries set amount = 999 where wallet_id = ?`, [wallet.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(sql(h, `delete from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).rejects.toThrow(
      /append-only/,
    );
  });

  test("saldo negativo é barrado por CHECK", async () => {
    const wallet = await openWallet(h, "10.00");
    await expect(sql(h, `update wallets set balance = -0.01 where id = ?`, [wallet.id])).rejects.toThrow(
      /wallets_balance_non_negative/,
    );
  });

  test("idempotency key duplicada é barrada por UNIQUE", async () => {
    const wallet = await openWallet(h, "10.00");
    const bet = command(wallet, "BET", "1.00");
    await h.submit.execute(bet);
    await expect(
      sql(
        h,
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
         values (?, 'provider-x', ?, ?, repeat('a', 64), ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now())`,
        [uuid(), `ext-${uuid()}`, bet.idempotencyKey, wallet.id, wallet.playerId],
      ),
    ).rejects.toThrow(/wager_tx_idempotency_key_uq/);
  });

  test("lançamento com aritmética errada é barrado por CHECK", async () => {
    const wallet = await openWallet(h, "10.00");
    const bet = await h.submit.execute(command(wallet, "LOSS", "1.00"));
    await expect(
      sql(
        h,
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
           balance_before, balance_after, created_at)
         values (?, ?, ?, 'DEBIT', 5, 'BRL', 10, 9, now())`,
        [uuid(), wallet.id, bet.transactionId],
      ),
    ).rejects.toThrow(/ledger_arithmetic/);
  });
});
