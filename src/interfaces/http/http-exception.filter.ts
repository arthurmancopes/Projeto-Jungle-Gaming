import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import {
  ApplicationError,
  DuplicateWalletError,
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  ValidationError,
  WalletNotFoundError,
} from "../../application/errors";
import { DomainError, FailureCode, InvalidMoneyError, InvalidTransactionError } from "../../domain/errors";
import { noopLogger, type Logger } from "../../application/ports/logger";
import { translateError } from "../../infrastructure/persistence/unit-of-work";
import type { HttpRequest, HttpResponse } from "./http-types";

export interface ErrorBody {
  code: string;
  message: string;
  correlationId?: string;
}

interface Mapped {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

/**
 * Mapeamento único de erro -> status HTTP, igual em todos os endpoints:
 *   400 payload inválido | 404 não encontrado | 409 conflito | 503 falha transitória (pode reenviar).
 * Rejeição de negócio (422) e aceite pendente (202) não são erros: saem pelo controller.
 */
export function mapError(error: unknown): Mapped {
  const translated = translateError(error);

  if (
    translated instanceof InvalidMoneyError ||
    translated instanceof InvalidTransactionError ||
    translated instanceof ValidationError
  ) {
    return { status: 400, code: translated.code, message: translated.message };
  }
  if (translated instanceof WalletNotFoundError || translated instanceof NotFoundError) {
    return { status: 404, code: translated.code, message: translated.message };
  }
  if (translated instanceof IdempotencyConflictError || translated instanceof DuplicateWalletError) {
    return { status: 409, code: translated.code, message: translated.message };
  }
  if (translated instanceof TransientInfrastructureError) {
    return {
      status: 503,
      code: translated.code,
      message: "Temporary failure. Retry with the same Idempotency-Key.",
      retryAfterSeconds: 1,
    };
  }
  if (translated instanceof HttpException) {
    const status = translated.getStatus();
    const code =
      status === 400 ? FailureCode.InvalidPayload : status === 404 ? "NOT_FOUND" : `HTTP_${status}`;
    return { status, code, message: translated.message };
  }
  if (translated instanceof DomainError || translated instanceof ApplicationError) {
    // Erro de domínio não mapeado acima é erro de programação: não expõe detalhes.
    return { status: 500, code: "INTERNAL_ERROR", message: "Internal error" };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal error" };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger = noopLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const mapped = mapError(error);

    if (mapped.status >= 500 && mapped.status !== 503) {
      this.logger.error("unhandled error", {
        correlationId: request.correlationId,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
    } else if (mapped.status === 503) {
      this.logger.warn("transient failure", { correlationId: request.correlationId, code: mapped.code });
    }
    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(mapped.retryAfterSeconds));
    }
    const body: ErrorBody = { code: mapped.code, message: mapped.message, correlationId: request.correlationId };
    response.status(mapped.status).json(body);
  }
}
