import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { CORRELATION_HEADER, type HttpRequest, type HttpResponse } from "./http-types";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Middleware: reaproveita o X-Correlation-Id recebido (se bem formado) ou gera um, e o devolve na resposta. */
export function correlationMiddleware(req: HttpRequest, res: HttpResponse, next: () => void): void {
  const received = req.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(received) ? received[0] : received;
  const correlationId = candidate && SAFE_ID.test(candidate) ? candidate : Bun.randomUUIDv7();
  req.correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);
  next();
}

export const CorrelationId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<HttpRequest>();
  return request.correlationId ?? Bun.randomUUIDv7();
});
