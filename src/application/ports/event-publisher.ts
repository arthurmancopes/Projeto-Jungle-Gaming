import type { OutboxMessage } from "../../domain/outbox-message";

/** Publica um evento de integração no broker. Lança em caso de falha (a outbox agenda nova tentativa). */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
