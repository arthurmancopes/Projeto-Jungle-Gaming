import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FailureCode } from "../../src/domain/errors";
import { command, createHarness, expectConsistent, openWallet, sql, type Harness } from "../integration/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const TIMEOUT = 60_000;
setDefaultTimeout(TIMEOUT); // vale também para os hooks (abrir e fechar o pool)

describe("Concorrência na mesma wallet (PostgreSQL real, requisições em paralelo)", () => {
  test(
    "cenário obrigatório: saldo 100.00 e duas apostas de 80.00 simultâneas",
    async () => {
      const wallet = await openWallet(h, "100.00");

      const results = await Promise.all([
        h.submit.execute(command(wallet, "BET", "80.00")),
        h.submit.execute(command(wallet, "BET", "80.00")),
      ]);

      expect(results.map((r) => String(r.status)).sort()).toEqual(["PROCESSED", "REJECTED"]);
      const rejected = results.find((r) => r.status === "REJECTED");
      expect(rejected?.failureCode).toBe(FailureCode.InsufficientFunds);

      const snap = await expectConsistent(h, wallet.id);
      expect(snap.balance).toBe("20.00");
      expect(snap.debits).toBe(1);
      expect(snap.version).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "a mesma aposta enviada 50 vezes em paralelo gera um único débito",
    async () => {
      const wallet = await openWallet(h, "1000.00");
      const same = command(wallet, "BET", "25.00");

      const results = await Promise.all(Array.from({ length: 50 }, () => h.submit.execute({ ...same })));

      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(results.every((r) => r.status === "PROCESSED" && r.balance.amount === "975.00")).toBe(true);

      const snap = await expectConsistent(h, wallet.id);
      expect(snap.balance).toBe("975.00");
      expect(snap.debits).toBe(1);

      const rows = await sql(h, `select id from wager_transactions where idempotency_key = ?`, [same.idempotencyKey]);
      expect(rows).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "30 apostas distintas de 10.00 disputando 100.00: exatamente 10 passam, saldo nunca negativo",
    async () => {
      const wallet = await openWallet(h, "100.00");

      const results = await Promise.all(
        Array.from({ length: 30 }, () => h.submit.execute(command(wallet, "BET", "10.00"))),
      );

      expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(10);
      expect(results.filter((r) => r.status === "REJECTED")).toHaveLength(20);

      const snap = await expectConsistent(h, wallet.id);
      expect(snap.balance).toBe("0.00");
      expect(snap.debits).toBe(10);
      expect(snap.version).toBe(11);
    },
    TIMEOUT,
  );

  test(
    "apostas e prêmios misturados mantêm saldo == ledger",
    async () => {
      const wallet = await openWallet(h, "50.00");

      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          h.submit.execute(command(wallet, i % 2 === 0 ? "BET" : "WIN", i % 2 === 0 ? "7.50" : "3.25")),
        ),
      );

      const snap = await expectConsistent(h, wallet.id);
      expect(snap.balance.startsWith("-")).toBe(false);
      expect(snap.version).toBe(snap.entries); // abertura: 1 lançamento e version 1; cada movimento soma 1 em ambos
    },
    TIMEOUT,
  );
});

describe("Wallets distintas em paralelo", () => {
  test(
    "20 wallets, 5 apostas cada, sem interferência entre elas",
    async () => {
      const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(h, "100.00")));

      await Promise.all(
        wallets.flatMap((wallet) =>
          Array.from({ length: 5 }, () => h.submit.execute(command(wallet, "BET", "10.00"))),
        ),
      );

      for (const wallet of wallets) {
        const snap = await expectConsistent(h, wallet.id);
        expect(snap.balance).toBe("50.00");
        expect(snap.debits).toBe(5);
      }
    },
    TIMEOUT,
  );
});
