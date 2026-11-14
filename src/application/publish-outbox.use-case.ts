import type { OutboxMessage } from "../domain/outbox-message";
import type { EventPublisher } from "./ports/event-publisher";
import { noopLogger, type Logger } from "./ports/logger";
import { noopMetrics, type Metrics } from "./ports/metrics";
import type { Clock } from "./ports/system";
import type { UnitOfWork } from "./ports/unit-of-work";

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

const GROUP_CONCURRENCY = 10;

/**
 * Publica um lote da outbox. Seguro com vários publishers concorrentes:
 *
 * - o lote é reservado com FOR UPDATE SKIP LOCKED e o lock dura até o commit,
 *   então dois publishers nunca pegam a mesma mensagem ao mesmo tempo;
 * - a mensagem só é marcada como publicada depois que o broker confirmou;
 * - se o processo morrer entre a publicação e o commit, o lock é liberado e outro
 *   publisher republica: a garantia é at-least-once, e o consumidor deduplica por eventId.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: Logger = noopLogger,
    private readonly metrics: Metrics = noopMetrics,
    private readonly batchSize = 50,
  ) {}

  async execute(): Promise<PublishOutboxResult> {
    const outcome = await this.uow.run(async (ctx) => {
      const messages = await ctx.outbox.claimDue(this.clock.now(), this.batchSize);
      const result: PublishOutboxResult = { claimed: messages.length, published: 0, failed: 0 };

      // Dentro do mesmo agregado a ordem é preservada; agregados diferentes vão em paralelo.
      const groups = [...groupByAggregate(messages).values()];
      for (let i = 0; i < groups.length; i += GROUP_CONCURRENCY) {
        const outcomes = await Promise.all(
          groups.slice(i, i + GROUP_CONCURRENCY).map((group) => this.publishGroup(group)),
        );
        // As gravações do resultado são sequenciais: a transação usa uma única conexão.
        for (const outcome of outcomes) {
          for (const message of outcome.touched) {
            await ctx.outbox.save(message);
          }
          result.published += outcome.published;
          result.failed += outcome.failed;
        }
      }
      return result;
    });
    // Contado depois do commit: o agendamento da nova tentativa está gravado.
    for (let i = 0; i < outcome.failed; i++) this.metrics.retryScheduled("outbox_publisher");
    return outcome;
  }

  private async publishGroup(
    group: OutboxMessage[],
  ): Promise<{ touched: OutboxMessage[]; published: number; failed: number }> {
    const touched: OutboxMessage[] = [];
    for (const message of group) {
      try {
        await this.publisher.publish(message);
        message.markPublished(this.clock.now());
        touched.push(message);
      } catch (error) {
        message.scheduleRetry(this.clock.now());
        touched.push(message);
        this.logger.warn("outbox publish failed; retry scheduled", {
          eventId: message.id,
          eventType: message.eventType,
          aggregateId: message.aggregateId,
          attempts: message.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        // Para de publicar este agregado neste lote: as seguintes continuam pendentes, na ordem.
        return { touched, published: touched.length - 1, failed: 1 };
      }
    }
    return { touched, published: touched.length, failed: 0 };
  }
}

function groupByAggregate(messages: OutboxMessage[]): Map<string, OutboxMessage[]> {
  const groups = new Map<string, OutboxMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.aggregateId);
    if (group) group.push(message);
    else groups.set(message.aggregateId, [message]);
  }
  return groups;
}
