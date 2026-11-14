import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { CreateWalletUseCase, WalletView } from "../../application/create-wallet.use-case";
import { ValidationError } from "../../application/errors";
import type { GetWalletQuery, LedgerPage, ListLedgerQuery } from "../../application/queries";
import type { ReconcileWalletUseCase, ReconciliationResult } from "../../application/reconcile-wallet.use-case";
import type { MoneyProps } from "../../domain/money";
import { AuthGuard } from "./auth.guard";
import { CorrelationId } from "./correlation";
import { CREATE_WALLET, GET_WALLET, LIST_LEDGER, RECONCILE_WALLET } from "./tokens";

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: CreateWalletUseCase,
    @Inject(GET_WALLET) private readonly getWallet: GetWalletQuery,
    @Inject(LIST_LEDGER) private readonly listLedger: ListLedgerQuery,
    @Inject(RECONCILE_WALLET) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: Record<string, unknown> | undefined, @CorrelationId() correlationId: string): Promise<WalletView> {
    // O formato é validado no caso de uso (playerId UUID, Money como string decimal).
    return this.createWallet.execute({
      playerId: body?.playerId as string,
      initialBalance: body?.initialBalance as MoneyProps,
      correlationId,
    });
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<LedgerPage> {
    if (limit !== undefined && !/^\d{1,4}$/.test(limit)) {
      throw new ValidationError("limit must be a positive integer");
    }
    return this.listLedger.execute(walletId, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string, @CorrelationId() correlationId: string): Promise<ReconciliationResult> {
    return this.reconcileWallet.execute(walletId, correlationId);
  }
}
