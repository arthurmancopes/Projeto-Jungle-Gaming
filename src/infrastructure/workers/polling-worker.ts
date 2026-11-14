import { noopLogger, type Logger } from "../../application/ports/logger";

export interface PollingWorkerOptions {
  name: string;
  /** Intervalo entre ciclos quando não há trabalho. */
  intervalMs: number;
  /** Executa um ciclo e devolve true se pode haver mais trabalho imediato (lote cheio). */
  tick: () => Promise<boolean>;
}

/**
 * Laço de trabalho agendado. Todas as instâncias rodam o mesmo worker;
 * a coordenação entre elas é feita no banco (SKIP LOCKED), não aqui.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly options: PollingWorkerOptions,
    private readonly logger: Logger = noopLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Espera o ciclo em andamento terminar (ele faz commit ou rollback por conta própria). */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let more = false;
      try {
        more = await this.options.tick();
      } catch (error) {
        this.logger.error("worker cycle failed", {
          worker: this.options.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.running) break;
      if (!more) {
        // Pequena variação evita que todas as instâncias consultem o banco no mesmo instante.
        const delay = this.options.intervalMs * (0.75 + Math.random() * 0.5);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }
}
