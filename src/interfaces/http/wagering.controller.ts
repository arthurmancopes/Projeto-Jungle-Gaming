import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import { ValidationError } from "../../application/errors";
import type { GetWagerTransactionQuery, WagerTransactionView } from "../../application/queries";
import type {
  SubmitWagerTransactionResult,
  SubmitWagerTransactionUseCase,
} from "../../application/submit-wager-transaction.use-case";
import type { MoneyProps } from "../../domain/money";
import { WagerTransactionStatus } from "../../domain/wager-transaction";
import { AuthGuard } from "./auth.guard";
import { CorrelationId } from "./correlation";
import type { HttpResponse } from "./http-types";
import { GET_TRANSACTION, SUBMIT_WAGER } from "./tokens";

/**
 * Status da submissão — o provedor decide o que fazer só pelo código HTTP:
 *   201 processada | 200 replay idempotente | 202 aceita, aguardando referência
 *   422 rejeitada por regra de negócio (não reenviar; ver failureCode)
 * Erros (400, 404, 409, 503) saem pelo filtro global.
 */
export function submissionStatus(result: SubmitWagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
  }
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(SUBMIT_WAGER) private readonly submitWager: SubmitWagerTransactionUseCase,
    @Inject(GET_TRANSACTION) private readonly getTransaction: GetWagerTransactionQuery,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: Record<string, unknown> | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SubmitWagerTransactionResult & { code?: string; message?: string; correlationId?: string }> {
    if (!idempotencyKey) {
      throw new ValidationError("Idempotency-Key header is required");
    }
    // Só os campos de negócio são repassados; a validação de formato fica no caso de uso.
    const result = await this.submitWager.execute({
      idempotencyKey,
      providerId: body?.providerId as string,
      externalTransactionId: body?.externalTransactionId as string,
      playerId: body?.playerId as string,
      walletId: body?.walletId as string,
      roundId: body?.roundId as string,
      gameId: body?.gameId as string,
      kind: body?.kind as string,
      money: body?.money as MoneyProps,
      ...(body?.referenceExternalTransactionId !== undefined && body.referenceExternalTransactionId !== null
        ? { referenceExternalTransactionId: body.referenceExternalTransactionId as string }
        : {}),
      correlationId,
    });

    const status = submissionStatus(result);
    response.status(status);
    if (status === 422) {
      // Mesmo formato de erro dos demais endpoints, acrescido do resultado da transação.
      return {
        code: result.failureCode ?? "REJECTED",
        message: "Transaction rejected by business rule",
        correlationId,
        ...result,
      };
    }
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  byId(@Param("transactionId") transactionId: string): Promise<WagerTransactionView> {
    return this.getTransaction.byId(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.getTransaction.byProviderAndExternalId(providerId, externalTransactionId);
  }
}
