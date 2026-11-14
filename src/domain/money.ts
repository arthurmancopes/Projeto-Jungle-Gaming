import { Decimal } from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

/** DTO de contrato: amount é SEMPRE string decimal, nunca number. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;

/**
 * Instância isolada do Decimal: não afeta (nem é afetada por) outras configurações globais.
 * ROUND_HALF_EVEN fica configurado por segurança, mas como só há add/subtract
 * de valores com no máximo 2 casas, nenhuma operação precisa arredondar.
 */
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Entrada aceita: inteiro sem zeros à esquerda, opcionalmente com 1 ou 2 casas decimais.
 * Rejeita por construção: "", "NaN", "Infinity", "1e5", "-1.00", "+1", "1.", ".5", "1.234", "01.00".
 */
const INPUT_AMOUNT = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/** Formato persistido/reidratado: o mesmo, mas aceita sinal negativo (resultado de operações internas). */
const STORED_AMOUNT = /^-?(0|[1-9]\d*)(\.\d{1,2})?$/;

const CURRENCY = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Factory para contratos de entrada (HTTP/SQS): não aceita valores negativos. */
  static from(props: MoneyProps): Money {
    Money.assertShape(props);
    if (!INPUT_AMOUNT.test(props.amount)) {
      throw new InvalidMoneyError(`amount "${props.amount}" must be a non-negative decimal string with up to ${MONEY_SCALE} decimal places`);
    }
    return new Money(new Dec(props.amount), props.currency);
  }

  /** Reconstrução a partir da persistência (coluna numeric). Aceita sinal, mas mantém a escala estrita. */
  static rehydrate(props: MoneyProps): Money {
    Money.assertShape(props);
    if (!STORED_AMOUNT.test(props.amount)) {
      throw new InvalidMoneyError(`stored amount "${props.amount}" is not a valid decimal`);
    }
    return new Money(new Dec(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new Dec(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Sempre com escala fixa de 2 casas. -0 é normalizado para "0.00". */
  get amount(): string {
    const v = this.value.isZero() ? new Dec(0) : this.value;
    return v.toFixed(MONEY_SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertShape(props: MoneyProps): void {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("money must be an object { amount, currency }");
    }
    // Defesa em runtime: JSON pode trazer number mesmo com o tipo dizendo string.
    if (typeof props.amount !== "string") {
      throw new InvalidMoneyError("amount must be a string");
    }
    Money.assertCurrency(props.currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`currency "${String(currency)}" must be an ISO-4217 code (3 uppercase letters)`);
    }
  }
}
