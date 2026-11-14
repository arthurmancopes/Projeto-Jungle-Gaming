import type { LoggerService } from "@nestjs/common";
import type { Logger } from "../../application/ports/logger";

/** Faz o NestJS escrever seus próprios logs pelo mesmo logger JSON da aplicação. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.logger.info(String(message), context(rest));
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.logger.error(String(message), context(rest));
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.logger.warn(String(message), context(rest));
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.logger.debug(String(message), context(rest));
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.logger.debug(String(message), context(rest));
  }
}

function context(rest: unknown[]): Record<string, unknown> {
  const last = rest[rest.length - 1];
  return typeof last === "string" ? { context: last } : {};
}
