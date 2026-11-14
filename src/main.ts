import { createApp } from "./app";
import { config } from "./infrastructure/config";

const app = await createApp();
await app.listen(config.port);
console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), msg: "http server started", port: config.port }));
