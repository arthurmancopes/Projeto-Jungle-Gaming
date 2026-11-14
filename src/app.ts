import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { config } from "./infrastructure/config";
import { AppModule } from "./interfaces/http/app.module";
import { correlationMiddleware } from "./interfaces/http/correlation";
import { HttpErrorFilter } from "./interfaces/http/http-exception.filter";

export interface CreateAppOptions {
  logger?: boolean;
  /** Consumidor SQS e workers agendados. Padrão: config.workers.enabled. */
  workers?: boolean;
}

/** Monta a aplicação (usada pelo main.ts e pelos testes de integração HTTP). */
export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const module = AppModule.forRoot({ workers: options.workers ?? config.workers.enabled });
  const app = await NestFactory.create(module, options.logger === false ? { logger: false } : {});
  app.use(correlationMiddleware);
  app.useGlobalFilters(new HttpErrorFilter());
  // SIGTERM: para de aceitar conexões, conclui requisições e mensagens em andamento, fecha o pool.
  app.enableShutdownHooks();
  return app;
}
