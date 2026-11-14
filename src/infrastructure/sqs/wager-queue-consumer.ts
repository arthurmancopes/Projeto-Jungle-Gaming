import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  IdempotencyConflictError,
  InboxConflictError,
  ValidationError,
  WalletNotFoundError,
} from "../../application/errors";
import { noopLogger, type Logger } from "../../application/ports/logger";
import type { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { InvalidMoneyError, InvalidTransactionError } from "../../domain/errors";
import { translateError } from "../persistence/unit-of-work";
import { parseWagerMessage } from "./wager-message";

export const WAGER_CONSUMER_NAME = "wager-transactions-consumer";

export type ErrorKind = "business" | "permanent" | "transient";
export type MessageOutcome = "acked" | "dead-lettered" | "retry";

/**
 * Classificação de erros do consumidor:
 * - business:  resultado definitivo de negócio que não gera transação persistida -> ack;
 * - permanent: a mensagem nunca vai ser processável (contrato inválido, conflito) -> DLQ;
 * - transient: infraestrutura ou erro desconhecido -> sem ack, nova entrega com backoff.
 *   Depois de maxReceiveCount entregas, a redrive policy da fila manda para a DLQ.
 * Rejeições de negócio comuns (saldo insuficiente etc.) nem chegam aqui: o caso de uso
 * as grava como REJECTED e retorna normalmente.
 */
export function classifyError(error: unknown): ErrorKind {
  const translated = translateError(error);
  if (translated instanceof WalletNotFoundError) return "business";
  if (
    translated instanceof InvalidMoneyError ||
    translated instanceof InvalidTransactionError ||
    translated instanceof ValidationError ||
    translated instanceof IdempotencyConflictError ||
    translated instanceof InboxConflictError
  ) {
    return "permanent";
  }
  return "transient";
}

/** Backoff exponencial da nova entrega: 2s, 4s, 8s, 16s ... limitado a 60s. */
export function retryVisibilitySeconds(receiveCount: number): number {
  return Math.min(2 ** Math.max(receiveCount, 1), 60);
}

export interface ConsumerHooks {
  onOutcome?(outcome: MessageOutcome, info: { receiveCount: number; errorKind?: ErrorKind }): void;
}

export interface WagerQueueConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
  maxMessages?: number;
  /** Tempo que o shutdown espera as mensagens em andamento antes de devolvê-las à fila. */
  shutdownTimeoutMs?: number;
  /** Atraso da nova entrega após falha transitória. Padrão: retryVisibilitySeconds (exponencial). */
  retryDelaySeconds?: (receiveCount: number) => number;
}

export class WagerQueueConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private pollAbort: AbortController | undefined;
  /** Mensagens recebidas e ainda não resolvidas (ack, DLQ ou devolvidas). */
  private readonly unresolved = new Map<string, Message>();

  constructor(
    private readonly client: SQSClient,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly options: WagerQueueConsumerOptions,
    private readonly logger: Logger = noopLogger,
    private readonly hooks: ConsumerHooks = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * SIGTERM: para de buscar mensagens, espera as que estão em andamento e devolve
   * a visibilidade das que não terminaram, para outra instância assumir imediatamente.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.pollAbort?.abort();

    const timeoutMs = this.options.shutdownTimeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      (this.loop ?? Promise.resolve()).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (timedOut) {
      this.logger.warn("consumer shutdown timed out; releasing in-flight messages", {
        messages: this.unresolved.size,
      });
    }
    await Promise.all([...this.unresolved.values()].map((message) => this.release(message)));
    this.unresolved.clear();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        this.logger.error("sqs poll failed", { error: errorMessage(error) });
        await sleep(1000);
      }
    }
  }

  /** Recebe e processa um lote. Devolve o resultado de cada mensagem (útil nos testes). */
  async pollOnce(overrides: { waitTimeSeconds?: number } = {}): Promise<MessageOutcome[]> {
    this.pollAbort = new AbortController();
    let messages: Message[];
    try {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: this.options.maxMessages ?? 10,
          WaitTimeSeconds: overrides.waitTimeSeconds ?? this.options.waitTimeSeconds ?? 10,
          VisibilityTimeout: this.options.visibilityTimeoutSeconds ?? 30,
          MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        }),
        { abortSignal: this.pollAbort.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.pollAbort.signal.aborted) return [];
      throw error;
    }
    for (const message of messages) {
      if (message.ReceiptHandle) this.unresolved.set(message.ReceiptHandle, message);
    }

    // Grupos (wallets) diferentes em paralelo; dentro do grupo, em ordem.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? "ungrouped";
      const list = groups.get(group);
      if (list) list.push(message);
      else groups.set(group, [message]);
    }
    const outcomes = await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
    return outcomes.flat();
  }

  private async processGroup(group: Message[]): Promise<MessageOutcome[]> {
    const outcomes: MessageOutcome[] = [];
    let blocked = false;
    for (const message of group) {
      // Depois de uma falha (ou do pedido de shutdown), as seguintes do grupo voltam para a
      // fila sem serem processadas: preserva a ordem e libera para outra instância.
      if (blocked || (!this.running && this.loop !== undefined)) {
        await this.release(message);
        outcomes.push("retry");
        continue;
      }
      const outcome = await this.handle(message);
      outcomes.push(outcome);
      if (outcome === "retry") blocked = true;
    }
    return outcomes;
  }

  private async handle(message: Message): Promise<MessageOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const parsed = parseWagerMessage(message.Body);
    const fields = { sqsMessageId: message.MessageId, receiveCount };

    try {
      if (!parsed.ok) {
        await this.deadLetter(message, "INVALID_MESSAGE");
        this.logger.warn("message dead-lettered: invalid contract", { ...fields, reason: parsed.reason });
        this.hooks.onOutcome?.("dead-lettered", { receiveCount, errorKind: "permanent" });
        return "dead-lettered";
      }

      const { messageId, data } = parsed.message;
      const context = {
        ...fields,
        messageId,
        correlationId: messageId,
        walletId: data.walletId,
        providerId: data.providerId,
      };

      let result: Awaited<ReturnType<SubmitWagerTransactionUseCase["execute"]>>;
      try {
        result = await this.submit.execute({
          idempotencyKey: data.idempotencyKey,
          providerId: data.providerId,
          externalTransactionId: data.externalTransactionId,
          playerId: data.playerId,
          walletId: data.walletId,
          roundId: data.roundId,
          gameId: data.gameId,
          kind: data.kind,
          money: data.money,
          ...(data.referenceExternalTransactionId !== undefined
            ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
            : {}),
          correlationId: messageId,
          inbox: { consumerName: WAGER_CONSUMER_NAME, messageId },
        });
      } catch (error) {
        const kind = classifyError(error);
        const code = (translateError(error) as { code?: string }).code;
        if (kind === "business") {
          await this.ack(message);
          this.logger.warn("message rejected by business rule", { ...context, code });
          this.hooks.onOutcome?.("acked", { receiveCount, errorKind: kind });
          return "acked";
        }
        if (kind === "permanent") {
          await this.deadLetter(message, code ?? "PERMANENT_FAILURE");
          this.logger.warn("message dead-lettered: permanent failure", { ...context, code });
          this.hooks.onOutcome?.("dead-lettered", { receiveCount, errorKind: kind });
          return "dead-lettered";
        }
        await this.backoff(message, receiveCount);
        this.logger.warn("transient failure; message will be redelivered", {
          ...context,
          code,
          error: errorMessage(error),
        });
        this.hooks.onOutcome?.("retry", { receiveCount, errorKind: kind });
        return "retry";
      }

      // O commit já aconteceu: só agora a mensagem é confirmada. Se o ack falhar (ou o processo
      // morrer aqui), a mensagem é reentregue e o inbox transforma a reentrega em replay.
      await this.ack(message);
      this.logger.info("message processed", {
        ...context,
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      this.hooks.onOutcome?.("acked", { receiveCount });
      return "acked";
    } catch (error) {
      // Falha ao falar com o SQS (ack, DLQ, visibilidade): a mensagem reaparece sozinha
      // quando a visibilidade expirar, e o inbox garante que o efeito não se repete.
      this.forget(message);
      this.logger.error("failed to settle message with sqs", { ...fields, error: errorMessage(error) });
      this.hooks.onOutcome?.("retry", { receiveCount, errorKind: "transient" });
      return "retry";
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
    this.forget(message);
  }

  /** Erro permanente: copia para a DLQ com o motivo e só então remove da fila principal. */
  private async deadLetter(message: Message, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: message.MessageId ?? Bun.randomUUIDv7(),
        MessageAttributes: { reason: { DataType: "String", StringValue: reason } },
      }),
    );
    await this.ack(message);
  }

  private async backoff(message: Message, receiveCount: number): Promise<void> {
    const delay = (this.options.retryDelaySeconds ?? retryVisibilitySeconds)(receiveCount);
    await this.changeVisibility(message, delay);
  }

  private async release(message: Message): Promise<void> {
    try {
      await this.changeVisibility(message, 0);
    } catch (error) {
      this.logger.warn("failed to release message", { sqsMessageId: message.MessageId, error: errorMessage(error) });
      this.forget(message);
    }
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
    this.forget(message);
  }

  private forget(message: Message): void {
    if (message.ReceiptHandle) this.unresolved.delete(message.ReceiptHandle);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
