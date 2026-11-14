/** Origem do processamento de uma transação. */
export type WagerSource = "http" | "sqs" | "pending_reference";

/** Componente que agendou uma nova tentativa. */
export type RetryComponent = "sqs_consumer" | "outbox_publisher" | "pending_reference";

/**
 * Métricas de negócio e de operação. A camada de aplicação só conhece esta porta;
 * a implementação Prometheus fica na infraestrutura.
 */
export interface Metrics {
  /** Transação concluída pela primeira vez (replays não contam aqui). */
  transactionCompleted(labels: { source: WagerSource; kind: string; status: string; failureCode?: string }): void;
  /** Requisição ou mensagem repetida, resolvida como replay. */
  duplicateDetected(labels: { source: WagerSource; reason: "idempotency_key" | "inbox" }): void;
  retryScheduled(component: RetryComponent): void;
  /** Mensagem enviada explicitamente para a DLQ pelo consumidor. */
  deadLettered(reason: string): void;
  /** Disputa de lock: timeout, deadlock ou version divergente. */
  lockConflict(): void;
  processingDuration(labels: { source: WagerSource; outcome: string }, seconds: number): void;
  reconciliationMismatch(): void;
}

export const noopMetrics: Metrics = {
  transactionCompleted() {},
  duplicateDetected() {},
  retryScheduled() {},
  deadLettered() {},
  lockConflict() {},
  processingDuration() {},
  reconciliationMismatch() {},
};
