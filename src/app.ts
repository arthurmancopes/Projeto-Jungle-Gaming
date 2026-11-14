import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Logger } from "./application/ports/logger";
import { config } from "./infrastructure/config";
import { NestLoggerAdapter } from "./infrastructure/observability/nest-logger";
import { AppModule } from "./interfaces/http/app.module";
import { correlationMiddleware } from "./interfaces/http/correlation";
import { HttpErrorFilter } from "./interfaces/http/http-exception.filter";
import { requestLoggingMiddleware } from "./interfaces/http/request-logging";
import { LOGGER } from "./interfaces/http/tokens";

export interface CreateAppOptions {
  /** false silencia os logs (testes). */
  logger?: boolean;
  /** Consumidor SQS e workers agendados. Padrão: config.workers.enabled. */
  workers?: boolean;
}

/** Monta a aplicação (usada pelo main.ts e pelos testes de integração HTTP). */
export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const module = AppModule.forRoot({ workers: options.workers ?? config.workers.enabled });
  const app = await NestFactory.create(module, options.logger === false ? { logger: false } : { bufferLogs: true });
  const logger = app.get<Logger>(LOGGER);
  if (options.logger !== false) {
    // Até os logs internos do Nest saem em JSON.
    app.useLogger(new NestLoggerAdapter(logger));
  }
  app.use(correlationMiddleware);
  if (options.logger !== false) {
    app.use(requestLoggingMiddleware(logger));
  }
  app.useGlobalFilters(new HttpErrorFilter(logger));
  // SIGTERM: para de aceitar conexões, conclui requisições e mensagens em andamento, fecha o pool.
  app.enableShutdownHooks();
  return app;
}
