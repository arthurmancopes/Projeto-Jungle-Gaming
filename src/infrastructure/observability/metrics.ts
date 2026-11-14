import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Metrics, RetryComponent, WagerSource } from "../../application/ports/metrics";

export interface MetricsCollectors {
  /** Mensagens pendentes na outbox e idade (s) da mais antiga. */
  outboxStats?: () => Promise<{ pending: number; oldestAgeSeconds: number }>;
  /** Mensagens paradas na DLQ (inclui as movidas pela redrive policy da fila). */
  dlqDepth?: () => Promise<number>;
}

/**
 * Métricas Prometheus, expostas em GET /metrics. Registry próprio por instância
 * da aplicação. Os gauges de outbox e DLQ são calculados no momento da coleta.
 */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Transações concluídas pela primeira vez, por origem, tipo, status e código de falha",
    labelNames: ["source", "kind", "status", "failure_code"] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Requisições ou mensagens repetidas resolvidas como replay",
    labelNames: ["source", "reason"] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Novas tentativas agendadas, por componente",
    labelNames: ["component"] as const,
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: "wager_dlq_messages_total",
    help: "Mensagens enviadas para a DLQ pelo consumidor (erro permanente)",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wallet_lock_conflicts_total",
    help: "Disputas de lock na wallet: timeout, deadlock ou version divergente",
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "Latência do processamento de uma transação",
    labelNames: ["source", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly reconciliationMismatches = new Counter({
    name: "wallet_reconciliation_mismatch_total",
    help: "Reconciliações em que saldo materializado e ledger divergiram",
    registers: [this.registry],
  });

  constructor(collectors: MetricsCollectors = {}) {
    collectDefaultMetrics({ register: this.registry });

    // Os dois gauges da outbox saem da mesma consulta; o cache curto evita consultar duas vezes por coleta.
    let cached: { at: number; stats: Promise<{ pending: number; oldestAgeSeconds: number }> } | undefined;
    const outboxStats = () => {
      if (!collectors.outboxStats) return undefined;
      if (!cached || Date.now() - cached.at > 500) {
        cached = { at: Date.now(), stats: collectors.outboxStats() };
      }
      return cached.stats;
    };

    const outboxPending: Gauge = new Gauge({
      name: "outbox_pending_messages",
      help: "Eventos gravados na outbox e ainda não publicados",
      registers: [this.registry],
      collect: async () => {
        try {
          const stats = await outboxStats();
          if (stats) outboxPending.set(stats.pending);
        } catch {
          // Banco indisponível: a coleta não falha; o readiness já sinaliza o problema.
        }
      },
    });
    const outboxLag: Gauge = new Gauge({
      name: "outbox_lag_seconds",
      help: "Idade do evento pendente mais antigo da outbox (0 quando vazia)",
      registers: [this.registry],
      collect: async () => {
        try {
          const stats = await outboxStats();
          if (stats) outboxLag.set(stats.oldestAgeSeconds);
        } catch {
          // Idem.
        }
      },
    });
    const dlq: Gauge = new Gauge({
      name: "sqs_dlq_messages",
      help: "Mensagens aguardando na DLQ de transações",
      registers: [this.registry],
      collect: async () => {
        if (!collectors.dlqDepth) return;
        try {
          dlq.set(await collectors.dlqDepth());
        } catch {
          // SQS indisponível: mantém o último valor conhecido.
        }
      },
    });
  }

  transactionCompleted(labels: { source: WagerSource; kind: string; status: string; failureCode?: string }): void {
    this.transactions.inc({
      source: labels.source,
      kind: labels.kind,
      status: labels.status,
      failure_code: labels.failureCode ?? "",
    });
  }

  duplicateDetected(labels: { source: WagerSource; reason: "idempotency_key" | "inbox" }): void {
    this.duplicates.inc(labels);
  }

  retryScheduled(component: RetryComponent): void {
    this.retries.inc({ component });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  processingDuration(labels: { source: WagerSource; outcome: string }, seconds: number): void {
    this.duration.observe(labels, seconds);
  }

  reconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
