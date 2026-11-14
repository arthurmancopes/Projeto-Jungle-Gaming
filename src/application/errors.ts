import { FailureCode } from "../domain/errors";

/** Erros da camada de aplicação. Assim como os de domínio, carregam um código estável. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = FailureCode.WalletNotFound;
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found for this player`);
  }
}

export class DuplicateWalletError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** Mesma idempotency key (ou mesmo id externo) com payload diferente: conflito, não replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = FailureCode.IdempotencyConflict;
  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

/** Mesmo messageId com conteúdo diferente: erro permanente (DLQ). */
export class InboxConflictError extends ApplicationError {
  readonly code = "INBOX_CONFLICT";
  constructor(messageId: string) {
    super(`Message ${messageId} was already received with a different payload`);
  }
}

/** Requisição malformada fora do corpo de negócio (header ausente, cursor inválido, limite inválido). */
export class ValidationError extends ApplicationError {
  readonly code = FailureCode.InvalidPayload;
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends ApplicationError {
  readonly code = "NOT_FOUND";
  constructor(what: string) {
    super(`${what} not found`);
  }
}

/** Falha temporária de infraestrutura: a operação pode ser repetida com a mesma idempotency key. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code: string = "TRANSIENT_FAILURE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Disputa por lock da wallet (timeout, deadlock ou version divergente). */
export class ConcurrencyConflictError extends TransientInfrastructureError {
  override readonly code = "CONCURRENCY_CONFLICT";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
