/**
 * Códigos de falha estáveis e legíveis por máquina.
 * O provedor usa o código (nunca a mensagem) para decidir se reenvia, corrige ou desiste.
 */
export enum FailureCode {
  // Validação de contrato (corrigir o payload)
  InvalidPayload = "INVALID_PAYLOAD",
  InvalidMoney = "INVALID_MONEY",
  CurrencyMismatch = "CURRENCY_MISMATCH",

  // Regras de negócio (terminais — não reenviar)
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  AlreadyReversed = "ALREADY_REVERSED",
  WalletNotFound = "WALLET_NOT_FOUND",

  // Idempotência
  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
}

/** Base de todos os erros de domínio: sempre carrega um código estável. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = FailureCode.InvalidMoney;
  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

/** Transação malformada na criação (ex.: REFUND sem referência, valor zero). */
export class InvalidTransactionError extends DomainError {
  readonly code = FailureCode.InvalidPayload;
  constructor(reason: string) {
    super(`Invalid transaction: ${reason}`);
  }
}

/** Débito maior que o saldo disponível. */
export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;
  constructor(walletId: string) {
    super(`Insufficient funds in wallet ${walletId}`);
  }
}

/** Erro de programação: tentativa de transição inválida (ex.: a partir de estado terminal). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
  constructor(from: string, to: string) {
    super(`Invalid transaction transition: ${from} -> ${to}`);
  }
}

/** Violação de invariante do modelo (erro de programação, não caminho de negócio). */
export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";
  constructor(message: string) {
    super(message);
  }
}
