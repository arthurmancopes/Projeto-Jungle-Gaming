import { InvariantViolationError } from "./errors";
import type { IntegrationEvent } from "./events/integration-event";

export const OUTBOX_MAX_RETRY_DELAY_SECONDS = 300;

/** Backoff exponencial da publicação: 2s, 4s, 8s ... limitado a 5 minutos. */
export function outboxRetryDelaySeconds(attempts: number): number {
  return Math.min(2 ** attempts, OUTBOX_MAX_RETRY_DELAY_SECONDS);
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Evento de integração aguardando publicação. É gravado na mesma transação SQL
 * do efeito financeiro e publicado depois por um worker.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: é ele que o consumidor usa para deduplicar. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff) */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + outboxRetryDelaySeconds(this._attempts) * 1000);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
  }
}
