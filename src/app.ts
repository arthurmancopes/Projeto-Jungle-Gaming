import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./interfaces/http/app.module";
import { correlationMiddleware } from "./interfaces/http/correlation";
import { HttpErrorFilter } from "./interfaces/http/http-exception.filter";

/** Monta a aplicação (usada pelo main.ts e pelos testes de integração HTTP). */
export async function createApp(options: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, options.logger === false ? { logger: false } : {});
  app.use(correlationMiddleware);
  app.useGlobalFilters(new HttpErrorFilter());
  // SIGTERM: para de aceitar conexões, conclui as requisições em andamento e fecha o pool.
  app.enableShutdownHooks();
  return app;
}
