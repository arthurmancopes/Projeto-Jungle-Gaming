import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Logger } from "../application/ports/logger";
import type { Metrics } from "../application/ports/metrics";
import type { PublishOutboxUseCase } from "../application/publish-outbox.use-case";
import type { RetryPendingReferencesUseCase } from "../application/retry-pending-references.use-case";
import type { SubmitWagerTransactionUseCase } from "../application/submit-wager-transaction.use-case";
import { config } from "../infrastructure/config";
import { resolveQueueUrl } from "../infrastructure/sqs/sqs-client";
import { WagerQueueConsumer } from "../infrastructure/sqs/wager-queue-consumer";
import { PollingWorker } from "../infrastructure/workers/polling-worker";
import {
  LOGGER,
  METRICS,
  PUBLISH_OUTBOX,
  RETRY_PENDING_REFERENCES,
  RUNTIME_OPTIONS,
  SQS_CLIENT,
  SUBMIT_WAGER,
  type RuntimeOptions,
} from "./http/tokens";

/**
 * Consumidor da fila e workers agendados. Toda instância roda os três;
 * a coordenação entre instâncias é do banco (inbox, SKIP LOCKED), não de um líder.
 *
 * Desligamento: beforeApplicationShutdown roda antes de o pool do banco fechar,
 * então as mensagens em andamento conseguem concluir e fazer commit.
 */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: WagerQueueConsumer | undefined;
  private readonly workers: PollingWorker[] = [];

  constructor(
    @Inject(RUNTIME_OPTIONS) private readonly options: RuntimeOptions,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SUBMIT_WAGER) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(PUBLISH_OUTBOX) private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(RETRY_PENDING_REFERENCES) private readonly retryPending: RetryPendingReferencesUseCase,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.workers) return;

    const [queueUrl, dlqUrl] = await Promise.all([
      resolveQueueUrl(this.sqs, config.queues.wagerTransactions),
      resolveQueueUrl(this.sqs, config.queues.wagerTransactionsDlq),
    ]);
    this.consumer = new WagerQueueConsumer(
      this.sqs,
      this.submit,
      {
        queueUrl,
        dlqUrl,
        shutdownTimeoutMs: config.workers.shutdownTimeoutMs,
        visibilityTimeoutSeconds: config.workers.visibilityTimeoutSeconds,
        waitTimeSeconds: config.workers.waitTimeSeconds,
      },
      this.logger,
      {
        onOutcome: (outcome, info) => {
          if (outcome === "retry") this.metrics.retryScheduled("sqs_consumer");
          if (outcome === "dead-lettered") this.metrics.deadLettered(info.errorKind ?? "permanent");
        },
      },
    );

    this.workers.push(
      new PollingWorker(
        {
          name: "outbox-publisher",
          intervalMs: config.workers.outboxIntervalMs,
          tick: async () => {
            const result = await this.publishOutbox.execute();
            return result.claimed > 0 && result.failed === 0;
          },
        },
        this.logger,
      ),
      new PollingWorker(
        {
          name: "pending-reference-retrier",
          intervalMs: config.workers.pendingReferenceIntervalMs,
          tick: async () => {
            const result = await this.retryPending.execute();
            return result.processed + result.rejected > 0;
          },
        },
        this.logger,
      ),
    );

    this.consumer.start();
    for (const worker of this.workers) worker.start();
    this.logger.info("background workers started", { workers: ["sqs-consumer", "outbox-publisher", "pending-reference-retrier"] });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer?.stop(), ...this.workers.map((worker) => worker.stop())]);
    if (this.consumer) this.logger.info("background workers stopped");
  }
}
