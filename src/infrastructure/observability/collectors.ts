import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { config } from "../config";
import { resolveQueueUrl } from "../sqs/sqs-client";
import type { MetricsCollectors } from "./metrics";

export function createCollectors(orm: MikroORM, sqs: SQSClient): MetricsCollectors {
  let dlqUrl: string | undefined;
  return {
    async outboxStats() {
      // Usa o índice parcial de pendentes (published_at is null).
      const rows = await orm.em.fork().execute<Array<{ pending: number; lag: number }>>(
        `select count(*)::int as pending,
                coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
           from outbox_messages
          where published_at is null`,
      );
      const row = rows[0];
      return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Number(row?.lag ?? 0) };
    },
    async dlqDepth() {
      dlqUrl ??= await resolveQueueUrl(sqs, config.queues.wagerTransactionsDlq);
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlqUrl,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      return (
        Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
      );
    },
  };
}
