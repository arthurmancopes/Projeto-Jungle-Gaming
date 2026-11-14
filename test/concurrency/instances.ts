import type { Subprocess } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const LOG_DIR = join(ROOT, "temp", "instances");

export const INSTANCE_VISIBILITY_TIMEOUT_SECONDS = 5;
export const INSTANCE_WAIT_TIME_SECONDS = 2;

/**
 * Uma instância morta no meio de um long polling deixa a requisição aberta no broker por até
 * WaitTimeSeconds, e a mensagem entregue a ela fica invisível por mais VisibilityTimeout.
 * Esperar esse tempo depois de matar instâncias devolve a fila limpa para os próximos testes.
 */
export const ABANDONED_RECEIVE_SETTLE_MS =
  (INSTANCE_WAIT_TIME_SECONDS + INSTANCE_VISIBILITY_TIMEOUT_SECONDS + 2) * 1000;

/**
 * Uma instância real da aplicação (bun src/main.ts) em um processo separado:
 * API HTTP, consumidor SQS e workers, como em produção. Os logs vão para temp/instances/.
 */
export class AppInstance {
  private process: Subprocess | undefined;
  private generation = 0;

  constructor(
    readonly name: string,
    readonly port: number,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get logPath(): string {
    return join(LOG_DIR, `${this.name}-${this.generation}.log`);
  }

  get running(): boolean {
    return this.process !== undefined && this.process.exitCode === null && !this.process.killed;
  }

  async start(): Promise<void> {
    mkdirSync(LOG_DIR, { recursive: true });
    this.generation++;
    this.process = Bun.spawn([process.execPath, "src/main.ts"], {
      // Sem herdar o terminal: no Windows, isso evita que o filho sobreviva ao encerramento.
      stdin: "ignore",
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(this.port),
        WORKERS_ENABLED: "true",
        DB_POOL_MAX: "8",
        LOG_LEVEL: "info",
        SQS_VISIBILITY_TIMEOUT_SECONDS: String(INSTANCE_VISIBILITY_TIMEOUT_SECONDS),
        SQS_WAIT_TIME_SECONDS: String(INSTANCE_WAIT_TIME_SECONDS),
        OUTBOX_INTERVAL_MS: "200",
        PENDING_REFERENCE_INTERVAL_MS: "300",
        SHUTDOWN_TIMEOUT_MS: "10000",
      },
      stdout: Bun.file(this.logPath),
      stderr: Bun.file(`${this.logPath}.err`),
    });
    await this.waitReady();
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  /** SIGKILL: o processo morre sem desligamento gracioso (simula crash). */
  async kill(): Promise<void> {
    if (!this.process) return;
    this.process.kill("SIGKILL");
    await this.process.exited;
    await this.assertStopped();
  }

  /** Garante que nada mais responde na porta: uma instância viva consumiria a fila de outros testes. */
  private async assertStopped(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${this.baseUrl}/health/live`, {
          headers: { connection: "close" },
          signal: AbortSignal.timeout(500),
        });
      } catch {
        return; // conexão recusada: o processo saiu de fato
      }
      await Bun.sleep(200);
    }
    throw new Error(`${this.name} (pid ${this.process?.pid}) still answers on port ${this.port} after being killed`);
  }

  /** SIGTERM: desligamento gracioso. Devolve o código de saída. */
  async terminate(): Promise<number> {
    if (!this.process) return 0;
    this.process.kill("SIGTERM");
    return this.process.exited;
  }

  /** Quantas mensagens da fila esta instância processou (lido dos seus logs JSON). */
  async processedMessageIds(prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let g = 1; g <= this.generation; g++) {
      const file = Bun.file(join(LOG_DIR, `${this.name}-${g}.log`));
      if (!(await file.exists())) continue;
      for (const line of (await file.text()).split("\n")) {
        if (!line.includes('"message processed"')) continue;
        try {
          const entry = JSON.parse(line) as { messageId?: string };
          if (entry.messageId?.startsWith(prefix)) ids.push(entry.messageId);
        } catch {
          // linha parcial (processo morto no meio da escrita)
        }
      }
    }
    return ids;
  }

  private async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.process?.exitCode !== null && this.process?.exitCode !== undefined) {
        const err = await Bun.file(`${this.logPath}.err`).text().catch(() => "");
        throw new Error(`${this.name} exited during startup (code ${this.process.exitCode}):\n${err.slice(-2000)}`);
      }
      try {
        const response = await fetch(`${this.baseUrl}/health/ready`, { headers: { connection: "close" } });
        if (response.status === 200) return;
      } catch {
        // ainda subindo
      }
      await Bun.sleep(250);
    }
    throw new Error(`${this.name} did not become ready in ${timeoutMs}ms`);
  }
}

export async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 90_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${description}`);
}
