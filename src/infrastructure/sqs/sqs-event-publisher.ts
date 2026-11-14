import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain/outbox-message";

/**
 * Publica o envelope do evento na fila FIFO de eventos.
 * - MessageGroupId = aggregateId: ordem preservada por agregado.
 * - MessageDeduplicationId = eventId: o broker descarta republicações dentro da sua janela
 *   de 5 minutos. É uma otimização; a garantia é o consumidor deduplicar por eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: message.eventType },
        },
      }),
    );
  }
}
