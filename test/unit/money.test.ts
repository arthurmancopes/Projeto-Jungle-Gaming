import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money — criação e escala", () => {
  test.each([
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["25.05", "25.05"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["999999999999.99", "999999999999.99"],
  ])("from(%p) serializa com 2 casas: %p", (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test.each([
    [""],
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["1e5"],
    ["1E2"],
    ["-1.00"],
    ["+1.00"],
    ["1.234"],
    ["1."],
    [".50"],
    ["01.00"],
    [" 1.00"],
    ["1,00"],
    ["abc"],
  ])("rejeita amount inválido %p", (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount como number em runtime", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each([["brl"], ["BR"], ["BRLL"], [""]])("rejeita currency inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("Money — aritmética exata", () => {
  test("0.10 + 0.20 === 0.30 (sem erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("subtract pode produzir negativo (quem barra é a Wallet)", () => {
    const result = brl("10.00").subtract(brl("25.50"));
    expect(result.isNegative()).toBe(true);
    expect(result.amount).toBe("-15.50");
  });

  test("negate e zero", () => {
    expect(brl("5.00").negate().amount).toBe("-5.00");
    expect(Money.zero("BRL").negate().amount).toBe("0.00");
    expect(Money.zero("BRL").isZero()).toBe(true);
  });

  test("comparações", () => {
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").isPositive()).toBe(true);
    expect(brl("1.5").equals(brl("1.50"))).toBe(true);
  });

  test("imutabilidade: operações retornam nova instância", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.amount).toBe("10.00");
    expect(b.amount).toBe("15.00");
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("soma de muitos centavos permanece exata", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 10_000; i++) total = total.add(brl("0.01"));
    expect(total.amount).toBe("100.00");
  });
});

describe("Money — conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s entre moedas diferentes lança CurrencyMismatchError", (_name, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });

  test("equals entre moedas diferentes é false (não lança)", () => {
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});

describe("Money — reidratação", () => {
  test("aceita valor negativo vindo da persistência", () => {
    expect(Money.rehydrate({ amount: "-3.00", currency: "BRL" }).isNegative()).toBe(true);
  });

  test("rejeita escala inválida mesmo na reidratação", () => {
    expect(() => Money.rehydrate({ amount: "1.001", currency: "BRL" })).toThrow(InvalidMoneyError);
  });
});
