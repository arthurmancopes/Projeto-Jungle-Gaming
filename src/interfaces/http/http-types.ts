/** Subconjunto estrutural de request/response do Express usado por esta camada. */
export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  originalUrl?: string;
  correlationId?: string;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  headersSent?: boolean;
  statusCode?: number;
  on?(event: "finish", listener: () => void): void;
}

export const CORRELATION_HEADER = "x-correlation-id";
