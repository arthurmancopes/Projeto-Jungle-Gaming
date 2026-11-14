import { InvalidTransactionError, type FailureCode } from "../domain/errors";
import { InboxMessage } from "../domain/inbox-message";
import { Money, type MoneyProps } from "../domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from "../domain/wager-transaction";
import { IdempotencyConflictError, InboxConflictError, WalletNotFoundError } from "./errors";
import { computePayloadHash } from "./payload-hash";
import { noopMetrics, type Metrics, type WagerSource } from "./ports/metrics";
import type { Clock, IdGenerator } from "./ports/system";
import type { TransactionContext, UnitOfWork } from "./ports/unit-of-work";
import type { WagerProcessor } from "./wager-processor";

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** Presente quando a entrada é a fila: registra a mensagem no inbox na mesma transação. */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
const MAX_TEXT_LENGTH = 255;

/**
 * Caso de uso único de submissão — HTTP e SQS passam por aqui.
 * Inbox, transação, saldo, ledger e outbox são gravados em UMA transação SQL.
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics = noopMetrics,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const source: WagerSource = command.inbox ? "sqs" : "http";
    const started = performance.now();
    let outcome = "error";
    try {
      const result = await this.submit(command, source);
      outcome = result.idempotentReplay ? "replay" : result.status.toLowerCase();
      return result;
    } finally {
      this.metrics.processingDuration({ source, outcome }, (performance.now() - started) / 1000);
    }
  }

  private async submit(
    command: SubmitWagerTransactionCommand,
    source: WagerSource,
  ): Promise<SubmitWagerTransactionResult> {
    // Validação de contrato fora da transação: payload inválido não toca o banco.
    const money = validate(command);
    const payloadHash = computePayloadHash(command);
    let duplicateMessage = false;

    const result = await this.uow.run(async (ctx) => {
      // 1. Inbox: dedup persistente por (consumerName, messageId).
      const inboxMessage = command.inbox ? await this.receive(ctx, command.inbox, payloadHash) : undefined;
      duplicateMessage = command.inbox !== undefined && inboxMessage === undefined;

      // 2. A wallet precisa existir e pertencer ao player (leitura sem lock).
      const existingWallet = await ctx.wallets.findById(command.walletId);
      if (!existingWallet || existingWallet.playerId !== command.playerId) {
        throw new WalletNotFoundError(command.walletId);
      }

      // 3. Portão de idempotência: o índice único decide quem processa.
      //    Requisições idênticas simultâneas ficam bloqueadas aqui até o commit da primeira.
      const transaction = WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        now: this.clock.now(),
      });
      const inserted = await ctx.transactions.insertIfAbsent(transaction);

      let result: SubmitWagerTransactionResult;
      if (inserted) {
        // 4. Primeira vez: lock da wallet, regras, ledger e outbox.
        const { wallet } = await this.processor.process(ctx, transaction, command.correlationId);
        result = toResult(transaction, wallet.balance, false);
      } else {
        result = await this.replay(ctx, command, payloadHash, existingWallet.balance);
      }

      // 5. Marca a mensagem como processada na mesma transação do efeito.
      if (inboxMessage) {
        inboxMessage.markProcessed(this.clock.now());
        await ctx.inbox.markProcessed(inboxMessage);
      }
      return result;
    });

    // Métricas só depois do commit: uma transação desfeita não conta.
    if (result.idempotentReplay) {
      this.metrics.duplicateDetected({ source, reason: duplicateMessage ? "inbox" : "idempotency_key" });
    } else {
      this.metrics.transactionCompleted({
        source,
        kind: command.kind,
        status: result.status,
        ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
      });
    }
    return result;
  }

  /** Devolve a mensagem recém-registrada, ou undefined se for uma reentrega já processada. */
  private async receive(
    ctx: TransactionContext,
    inbox: { consumerName: string; messageId: string },
    payloadHash: string,
  ): Promise<InboxMessage | undefined> {
    const message = InboxMessage.receive({ ...inbox, payloadHash, receivedAt: this.clock.now() });
    if (await ctx.inbox.insertIfAbsent(message)) {
      return message;
    }
    const previous = await ctx.inbox.find(inbox.consumerName, inbox.messageId);
    if (previous && !previous.matchesPayload(payloadHash)) {
      throw new InboxConflictError(inbox.messageId);
    }
    return undefined;
  }

  private async replay(
    ctx: TransactionContext,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    currentBalance: Money,
  ): Promise<SubmitWagerTransactionResult> {
    const original = await ctx.transactions.findByIdempotencyKey(command.idempotencyKey);
    // Sem registro para a key: o conflito foi no par (providerId, externalTransactionId).
    if (!original || !original.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    // Resultado original, com o saldo observado naquele momento. Transação ainda
    // pendente de referência não tem saldo observado: devolve o saldo atual.
    return toResult(original, original.observedBalance ?? currentBalance, true);
  }
}

function toResult(tx: WagerTransaction, balance: Money, idempotentReplay: boolean): SubmitWagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
    balance: balance.toJSON(),
    idempotentReplay,
  };
}

function validate(command: SubmitWagerTransactionCommand): Money {
  const text = (name: string, value: unknown): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
      throw new InvalidTransactionError(`${name} must be a non-empty string (max ${MAX_TEXT_LENGTH} chars)`);
    }
  };
  text("idempotencyKey", command.idempotencyKey);
  text("providerId", command.providerId);
  text("externalTransactionId", command.externalTransactionId);
  text("roundId", command.roundId);
  text("gameId", command.gameId);
  if (command.referenceExternalTransactionId !== undefined) {
    text("referenceExternalTransactionId", command.referenceExternalTransactionId);
  }
  for (const field of ["playerId", "walletId"] as const) {
    if (typeof command[field] !== "string" || !UUID.test(command[field])) {
      throw new InvalidTransactionError(`${field} must be a UUID`);
    }
  }
  if (typeof command.kind !== "string" || !SUBMITTABLE_KINDS.has(command.kind)) {
    throw new InvalidTransactionError(`kind must be one of ${[...SUBMITTABLE_KINDS].join(", ")}`);
  }
  return Money.from(command.money);
}
