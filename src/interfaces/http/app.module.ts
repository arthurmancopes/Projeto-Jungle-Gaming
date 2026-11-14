import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";
import { CreateWalletUseCase } from "../../application/create-wallet.use-case";
import type { Logger } from "../../application/ports/logger";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { PublishOutboxUseCase } from "../../application/publish-outbox.use-case";
import { GetWagerTransactionQuery, GetWalletQuery, ListLedgerQuery } from "../../application/queries";
import { ReconcileWalletUseCase } from "../../application/reconcile-wallet.use-case";
import { RetryPendingReferencesUseCase } from "../../application/retry-pending-references.use-case";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { WagerProcessor } from "../../application/wager-processor";
import { config } from "../../infrastructure/config";
import { PinoLogger } from "../../infrastructure/observability/logger";
import { LoggingReconciliationAlert } from "../../infrastructure/observability/reconciliation-alert";
import ormConfig from "../../infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../infrastructure/persistence/unit-of-work";
import { createSqsClient, resolveQueueUrl } from "../../infrastructure/sqs/sqs-client";
import { SqsEventPublisher } from "../../infrastructure/sqs/sqs-event-publisher";
import { SystemClock, UuidV7Generator } from "../../infrastructure/system";
import { BackgroundWorkers } from "../background-workers";
import { AuthGuard, UnauthenticatedProviderIdentity } from "./auth.guard";
import { HealthController } from "./health.controller";
import {
  CREATE_WALLET,
  GET_TRANSACTION,
  GET_WALLET,
  LIST_LEDGER,
  LOGGER,
  ORM,
  PROVIDER_IDENTITY,
  PUBLISH_OUTBOX,
  RECONCILE_WALLET,
  RETRY_PENDING_REFERENCES,
  RUNTIME_OPTIONS,
  SQS_CLIENT,
  SUBMIT_WAGER,
  UNIT_OF_WORK,
  type RuntimeOptions,
} from "./tokens";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

const ids = new UuidV7Generator();
const clock = new SystemClock();

/** Fecha conexões no desligamento (SIGTERM), depois que requisições e workers terminaram. */
@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    this.sqs.destroy();
  }
}

/**
 * Composição: os casos de uso são classes puras (sem decorators do Nest),
 * montadas aqui por factories a partir das portas.
 */
@Module({})
export class AppModule {
  static forRoot(options: RuntimeOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        AuthGuard,
        InfrastructureLifecycle,
        BackgroundWorkers,
        { provide: RUNTIME_OPTIONS, useValue: options },
        { provide: LOGGER, useFactory: () => new PinoLogger() },
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
        {
          provide: PUBLISH_OUTBOX,
          useFactory: async (uow: UnitOfWork, sqs: SQSClient, logger: Logger) => {
            // Sem workers a fila de eventos não é usada: não exige o SQS no ar para subir a API.
            const queueUrl = options.workers ? await resolveQueueUrl(sqs, config.queues.events) : "";
            return new PublishOutboxUseCase(uow, new SqsEventPublisher(sqs, queueUrl), clock, logger);
          },
          inject: [UNIT_OF_WORK, SQS_CLIENT, LOGGER],
        },
        {
          provide: RETRY_PENDING_REFERENCES,
          useFactory: (uow: UnitOfWork, logger: Logger) =>
            new RetryPendingReferencesUseCase(uow, new WagerProcessor(ids, clock), clock, logger),
          inject: [UNIT_OF_WORK, LOGGER],
        },
      ],
    };
  }
}
