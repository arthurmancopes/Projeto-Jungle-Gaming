import type { Logger } from "../../application/ports/logger";
import type { HttpRequest, HttpResponse } from "./http-types";

const QUIET_PATHS = ["/health", "/metrics"];

/**
 * Uma linha de log por requisição: método, rota, status, duração e correlationId.
 * Sem corpo nem query string: nada de payload financeiro nos logs.
 */
export function requestLoggingMiddleware(logger: Logger) {
  return (req: HttpRequest, res: HttpResponse, next: () => void): void => {
    const started = performance.now();
    const path = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
    res.on?.("finish", () => {
      const fields = {
        correlationId: req.correlationId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      };
      if (QUIET_PATHS.some((prefix) => path.startsWith(prefix))) logger.debug("http request", fields);
      else if ((res.statusCode ?? 200) >= 500) logger.error("http request", fields);
      else logger.info("http request", fields);
    });
    next();
  };
}
