import { IsolationLevel } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  ApplicationError,
  ConcurrencyConflictError,
  TransientInfrastructureError,
} from "../../application/errors";
import { noopMetrics, type Metrics } from "../../application/ports/metrics";
import type { TransactionContext, UnitOfWork } from "../../application/ports/unit-of-work";
import { DomainError } from "../../domain/errors";
import { createTransactionContext } from "./repositories";

/** SQLSTATEs de disputa de lock: timeout de lock, deadlock e falha de serialização. */
const LOCK_CONFLICT_STATES = new Set(["55P03", "40P01", "40001"]);
/** Classes de SQLSTATE temporárias: conexão (08), recursos (53), intervenção do operador (57), sistema (58). */
const TRANSIENT_STATE_CLASSES = new Set(["08", "53", "57", "58"]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export interface UnitOfWorkOptions {
  /** Tempo máximo de espera por um lock de linha antes de desistir (falha transitória). */
  lockTimeoutMs?: number;
  metrics?: Metrics;
}

/**
 * Uma execução = um EntityManager em fork = uma transação SQL (READ COMMITTED).
 * Nenhum estado é compartilhado entre execuções.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;
  private readonly metrics: Metrics;

  constructor(
    private readonly orm: MikroORM,
    options: UnitOfWorkOptions = {},
  ) {
    this.lockTimeoutMs = Math.trunc(options.lockTimeoutMs ?? 5000);
    this.metrics = options.metrics ?? noopMetrics;
  }

  async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // Vale só para esta transação: uma wallet muito disputada não segura a conexão para sempre.
          await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
          return work(createTransactionContext(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      const translated = translateError(error);
      if (translated instanceof ConcurrencyConflictError) this.metrics.lockConflict();
      throw translated;
    }
  }
}

/** Lê o SQLSTATE (ou código de rede) do erro original, onde quer que o driver o tenha colocado. */
export function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; sqlState?: unknown; cause?: unknown };
    if (typeof candidate.sqlState === "string") return candidate.sqlState;
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

export function translateError(error: unknown): unknown {
  if (error instanceof DomainError || error instanceof ApplicationError) {
    return error;
  }
  const code = errorCode(error);
  if (code && LOCK_CONFLICT_STATES.has(code)) {
    return new ConcurrencyConflictError(`lock conflict (${code})`, { cause: error });
  }
  if (code && (TRANSIENT_STATE_CLASSES.has(code.slice(0, 2)) || TRANSIENT_NETWORK_CODES.has(code))) {
    return new TransientInfrastructureError(`database temporarily unavailable (${code})`, { cause: error });
  }
  return error;
}
