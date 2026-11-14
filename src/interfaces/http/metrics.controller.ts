import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { PrometheusMetrics } from "../../infrastructure/observability/metrics";
import type { HttpResponse } from "./http-types";
import { METRICS } from "./tokens";

/** Formato de exposição do Prometheus. Aberto, como os health checks. */
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  async render(@Res({ passthrough: true }) response: HttpResponse): Promise<string> {
    response.setHeader("Content-Type", this.metrics.contentType());
    return this.metrics.render();
  }
}
