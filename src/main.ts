import type { Logger } from "./application/ports/logger";
import { createApp } from "./app";
import { config } from "./infrastructure/config";
import { LOGGER } from "./interfaces/http/tokens";

const app = await createApp();
await app.listen(config.port);
app.get<Logger>(LOGGER).info("http server started", { port: config.port, workers: config.workers.enabled });
