import { describe, expect, test } from "bun:test";
import type { LogFields, Logger } from "../../src/application/ports/logger";
import type { LedgerReconciliation } from "../../src/application/ports/repositories";
import type { TransactionContext, UnitOfWork } from "../../src/application/ports/unit-of-work";
import { ReconcileWalletUseCase } from "../../src/application/reconcile-wallet.use-case";
import { Money } from "../../src/domain/money";
import { PrometheusMetrics } from "../../src/infrastructure/observability/metrics";
import { ObservableReconciliationAlert } from "../../src/infrastructure/observability/reconciliation-alert";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

class MemoryLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields: LogFields }> = [];
  debug(message: string, fields: LogFields = {}) {
    this.lines.push({ level: "debug", message, fields });
  }
  info(message: string, fields: LogFields = {}) {
    this.lines.push({ level: "info", message, fields });
  }
  warn(message: string, fields: LogFields = {}) {
    this.lines.push({ level: "warn", message, fields });
  }
  error(message: string, fields: LogFields = {}) {
    this.lines.push({ level: "error", message, fields });
  }
}

/** Só o ledger.reconcile é usado por este caso de uso; o resto do contexto não é tocado. */
function uowReturning(snapshot: LedgerReconciliation): UnitOfWork {
  const ctx = { ledger: { reconcile: async () => snapshot } } as unknown as TransactionContext;
  return { run: (work) => work(ctx) };
}

describe("Reconciliação: divergência é sinalizada, nunca corrigida", () => {
  test("saldo e ledger iguais: consistent, sem alerta", async () => {
    const metrics = new PrometheusMetrics();
    const logger = new MemoryLogger();
    const useCase = new ReconcileWalletUseCase(
      uowReturning({ storedBalance: brl("975.00"), calculatedBalance: brl("975.00"), checkedEntries: 42 }),
      new ObservableReconciliationAlert(logger, metrics),
    );

    expect(await useCase.execute(WALLET_ID, "corr-1")).toEqual({
      walletId: WALLET_ID,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 42,
    });
    expect(logger.lines).toHaveLength(0);
    expect(await metrics.render()).toContain("wallet_reconciliation_mismatch_total 0");
  });

  test("divergência: consistent false, log de erro e métrica incrementada", async () => {
    const metrics = new PrometheusMetrics();
    const logger = new MemoryLogger();
    const useCase = new ReconcileWalletUseCase(
      uowReturning({ storedBalance: brl("980.00"), calculatedBalance: brl("975.00"), checkedEntries: 42 }),
      new ObservableReconciliationAlert(logger, metrics),
    );

    const result = await useCase.execute(WALLET_ID, "corr-2");
    expect(result.consistent).toBe(false);
    expect(result.difference).toEqual({ amount: "5.00", currency: "BRL" });

    expect(logger.lines).toEqual([
      {
        level: "error",
        message: "wallet reconciliation mismatch",
        fields: {
          walletId: WALLET_ID,
          correlationId: "corr-2",
          difference: { amount: "5.00", currency: "BRL" },
          checkedEntries: 42,
        },
      },
    ]);
    expect(await metrics.render()).toContain("wallet_reconciliation_mismatch_total 1");
  });
});

describe("PrometheusMetrics", () => {
  test("registra contadores com rótulos e a latência em histograma", async () => {
    const metrics = new PrometheusMetrics();
    metrics.transactionCompleted({ source: "sqs", kind: "BET", status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    metrics.duplicateDetected({ source: "sqs", reason: "inbox" });
    metrics.retryScheduled("outbox_publisher");
    metrics.deadLettered("permanent");
    metrics.lockConflict();
    metrics.processingDuration({ source: "sqs", outcome: "rejected" }, 0.012);

    const text = await metrics.render();
    expect(text).toContain(
      'wager_transactions_total{source="sqs",kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS"} 1',
    );
    expect(text).toContain('wager_duplicates_total{source="sqs",reason="inbox"} 1');
    expect(text).toContain('wager_retries_total{component="outbox_publisher"} 1');
    expect(text).toContain('wager_dlq_messages_total{reason="permanent"} 1');
    expect(text).toContain("wallet_lock_conflicts_total 1");
    expect(text).toContain('wager_processing_duration_seconds_count{source="sqs",outcome="rejected"} 1');
  });

  test("gauges de outbox e DLQ são calculados na coleta, e falhas na coleta não quebram /metrics", async () => {
    const healthy = new PrometheusMetrics({
      outboxStats: async () => ({ pending: 3, oldestAgeSeconds: 1.5 }),
      dlqDepth: async () => 2,
    });
    const text = await healthy.render();
    expect(text).toContain("outbox_pending_messages 3");
    expect(text).toContain("outbox_lag_seconds 1.5");
    expect(text).toContain("sqs_dlq_messages 2");

    const broken = new PrometheusMetrics({
      outboxStats: () => Promise.reject(new Error("db down")),
      dlqDepth: () => Promise.reject(new Error("sqs down")),
    });
    expect(await broken.render()).toContain("# TYPE outbox_lag_seconds gauge");
  });
});
