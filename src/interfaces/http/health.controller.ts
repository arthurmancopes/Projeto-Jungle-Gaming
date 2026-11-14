import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, Inject, Res } from "@nestjs/common";
import { checkSqs } from "../../infrastructure/sqs/sqs-client";
import type { HttpResponse } from "./http-types";
import { ORM, SQS_CLIENT } from "./tokens";

type CheckStatus = "up" | "down";

/** Sem AuthGuard: health checks ficam abertos. */
@Controller("health")
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** Liveness: o processo está respondendo. Não toca em dependências. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 503 tira a instância do balanceamento. */
  @Get("ready")
  async ready(
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ status: "ok" | "unavailable"; checks: { postgres: CheckStatus; sqs: CheckStatus } }> {
    const [postgres, sqs] = await Promise.all([
      probe(() => this.orm.em.fork().execute("select 1")),
      probe(() => checkSqs(this.sqs)),
    ]);
    const ok = postgres === "up" && sqs === "up";
    response.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks: { postgres, sqs } };
  }
}

async function probe(check: () => Promise<unknown>): Promise<CheckStatus> {
  try {
    await check();
    return "up";
  } catch {
    return "down";
  }
}
