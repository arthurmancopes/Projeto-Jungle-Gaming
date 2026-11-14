/** Subconjunto estrutural de request/response do Express usado por esta camada. */
export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  headersSent?: boolean;
}

export const CORRELATION_HEADER = "x-correlation-id";
