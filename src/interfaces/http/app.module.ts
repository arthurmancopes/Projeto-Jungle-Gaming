import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { CreateWalletUseCase } from "../../application/create-wallet.use-case";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { GetWagerTransactionQuery, GetWalletQuery, ListLedgerQuery } from "../../application/queries";
import { ReconcileWalletUseCase } from "../../application/reconcile-wallet.use-case";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { WagerProcessor } from "../../application/wager-processor";
import { LoggingReconciliationAlert } from "../../infrastructure/observability/reconciliation-alert";
import ormConfig from "../../infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../infrastructure/persistence/unit-of-work";
import { createSqsClient } from "../../infrastructure/sqs/sqs-client";
import { SystemClock, UuidV7Generator } from "../../infrastructure/system";
import { AuthGuard, UnauthenticatedProviderIdentity } from "./auth.guard";
import { HealthController } from "./health.controller";
import {
  CREATE_WALLET,
  GET_TRANSACTION,
  GET_WALLET,
  LIST_LEDGER,
  ORM,
  PROVIDER_IDENTITY,
  RECONCILE_WALLET,
  SQS_CLIENT,
  SUBMIT_WAGER,
  UNIT_OF_WORK,
} from "./tokens";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

const ids = new UuidV7Generator();
const clock = new SystemClock();

/** Fecha conexões no desligamento (SIGTERM), depois que as requisições em andamento terminam. */
@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

/**
 * Composição: os casos de uso são classes puras (sem decorators do Nest),
 * montadas aqui por factories a partir das portas.
 */
@Module({
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    AuthGuard,
    InfrastructureLifecycle,
    { provide: ORM, useFactory: () => MikroORM.init(ormConfig) },
    { provide: SQS_CLIENT, useFactory: () => createSqsClient() },
    { provide: PROVIDER_IDENTITY, useFactory: () => new UnauthenticatedProviderIdentity() },
    { provide: UNIT_OF_WORK, useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm), inject: [ORM] },
    {
      provide: CREATE_WALLET,
      useFactory: (uow: UnitOfWork) => new CreateWalletUseCase(uow, ids, clock),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: SUBMIT_WAGER,
      useFactory: (uow: UnitOfWork) =>
        new SubmitWagerTransactionUseCase(uow, new WagerProcessor(ids, clock), ids, clock),
      inject: [UNIT_OF_WORK],
    },
    { provide: GET_WALLET, useFactory: (uow: UnitOfWork) => new GetWalletQuery(uow), inject: [UNIT_OF_WORK] },
    {
      provide: GET_TRANSACTION,
      useFactory: (uow: UnitOfWork) => new GetWagerTransactionQuery(uow),
      inject: [UNIT_OF_WORK],
    },
    { provide: LIST_LEDGER, useFactory: (uow: UnitOfWork) => new ListLedgerQuery(uow), inject: [UNIT_OF_WORK] },
    {
      provide: RECONCILE_WALLET,
      useFactory: (uow: UnitOfWork) => new ReconcileWalletUseCase(uow, new LoggingReconciliationAlert()),
      inject: [UNIT_OF_WORK],
    },
  ],
})
export class AppModule {}
