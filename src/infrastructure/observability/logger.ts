import pino from "pino";
import type { LogFields, Logger } from "../../application/ports/logger";

/**
 * Logs estruturados em JSON (uma linha por evento) via pino.
 * Regra: nunca logar payloads financeiros completos — só identificadores
 * (correlationId, messageId, transactionId, walletId, providerId), status e códigos.
 */
export class PinoLogger implements Logger {
  private readonly pino: pino.Logger;

  constructor(options: { level?: string; bindings?: LogFields } = {}) {
    this.pino = pino({
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      base: { service: "wagering-processor", ...options.bindings },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // Defesa extra caso algum objeto com dados sensíveis seja passado por engano.
      redact: { paths: ["authorization", "*.authorization", "headers.authorization"], remove: true },
    });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.pino.debug(fields, message);
  }
  info(message: string, fields: LogFields = {}): void {
    this.pino.info(fields, message);
  }
  warn(message: string, fields: LogFields = {}): void {
    this.pino.warn(fields, message);
  }
  error(message: string, fields: LogFields = {}): void {
    this.pino.error(fields, message);
  }
}
