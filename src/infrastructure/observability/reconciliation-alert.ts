import type { ReconciliationAlert } from "../../application/ports/reconciliation-alert";

/** Log estruturado (JSON) da divergência. A métrica correspondente entra junto com o módulo de métricas. */
export class LoggingReconciliationAlert implements ReconciliationAlert {
  mismatchDetected(info: Parameters<ReconciliationAlert["mismatchDetected"]>[0]): void {
    console.error(
      JSON.stringify({
        level: "error",
        time: new Date().toISOString(),
        msg: "wallet reconciliation mismatch",
        walletId: info.walletId,
        correlationId: info.correlationId,
        difference: info.difference,
        checkedEntries: info.checkedEntries,
      }),
    );
  }
}
