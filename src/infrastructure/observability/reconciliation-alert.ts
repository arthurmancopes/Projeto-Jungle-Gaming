import type { Logger } from "../../application/ports/logger";
import type { Metrics } from "../../application/ports/metrics";
import type { ReconciliationAlert } from "../../application/ports/reconciliation-alert";

/** Divergência: log de erro estruturado + métrica. Nunca é corrigida automaticamente. */
export class ObservableReconciliationAlert implements ReconciliationAlert {
  constructor(
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  mismatchDetected(info: Parameters<ReconciliationAlert["mismatchDetected"]>[0]): void {
    this.metrics.reconciliationMismatch();
    this.logger.error("wallet reconciliation mismatch", {
      walletId: info.walletId,
      correlationId: info.correlationId,
      difference: info.difference,
      checkedEntries: info.checkedEntries,
    });
  }
}
