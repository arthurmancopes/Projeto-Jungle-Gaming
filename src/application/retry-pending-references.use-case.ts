import { WagerTransactionStatus } from "../domain/wager-transaction";
import { noopLogger, type Logger } from "./ports/logger";
import { noopMetrics, type Metrics } from "./ports/metrics";
import type { Clock } from "./ports/system";
import type { UnitOfWork } from "./ports/unit-of-work";
import type { WagerProcessor } from "./wager-processor";

export interface RetryPendingReferencesResult {
  due: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
  failed: number;
}

/**
 * Reprocessa transações PENDING_REFERENCE vencidas (seção 7.1 do desafio).
 *
 * Cada transação roda na sua própria transação SQL e passa pelo MESMO WagerProcessor
 * da submissão: lock da wallet, regras, ledger e outbox. O backoff e o limite de
 * tentativas são regra de domínio (wager-rules.ts); esgotado o limite, a transação
 * vira REJECTED com REFERENCE_NOT_FOUND e o evento correspondente é publicado.
 */
export class RetryPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly logger: Logger = noopLogger,
    private readonly metrics: Metrics = noopMetrics,
    private readonly batchSize = 50,
  ) {}

  async execute(): Promise<RetryPendingReferencesResult> {
    const ids = await this.uow.run((ctx) =>
      ctx.transactions.findDuePendingReferenceIds(this.clock.now(), this.batchSize),
    );
    const result: RetryPendingReferencesResult = {
      due: ids.length,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      skipped: 0,
      failed: 0,
    };

    for (const id of ids) {
      const started = performance.now();
      try {
        const done = await this.uow.run(async (ctx) => {
          // Ordem de locks igual à da submissão: linha da transação, depois wallet.
          const transaction = await ctx.transactions.lockPendingReference(id);
          if (!transaction) return undefined; // outro worker pegou, ou já foi concluída
          await this.processor.process(ctx, transaction, `pending-reference:${id}`);
          return { kind: transaction.kind, status: transaction.status, failureCode: transaction.failureCode };
        });

        if (done === undefined) {
          result.skipped++;
          continue;
        }
        this.metrics.processingDuration(
          { source: "pending_reference", outcome: done.status.toLowerCase() },
          (performance.now() - started) / 1000,
        );
        if (done.status === WagerTransactionStatus.PendingReference) {
          result.stillPending++;
          this.metrics.retryScheduled("pending_reference");
          continue;
        }
        if (done.status === WagerTransactionStatus.Processed) result.processed++;
        else result.rejected++;
        this.metrics.transactionCompleted({
          source: "pending_reference",
          kind: done.kind,
          status: done.status,
          ...(done.failureCode !== undefined ? { failureCode: done.failureCode } : {}),
        });
      } catch (error) {
        // Falha isolada: as outras transações do lote seguem; esta será tentada no próximo ciclo.
        result.failed++;
        this.logger.warn("pending reference retry failed", {
          transactionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }
}
