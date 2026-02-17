import type { CortexClient } from "../../cortex/client.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class PeriodicReflect {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private client: CortexClient,
    private logger: Logger,
    private intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.run().catch((err) => {
        this.logger.warn(`Periodic reflect failed: ${String(err)}`);
      });
    }, this.intervalMs);

    this.logger.debug?.(`Periodic reflect: scheduled every ${this.intervalMs / 1000}s`);
  }

  async run(): Promise<void> {
    try {
      const result = await this.client.reflect();
      this.logger.info(
        `Reflect: synthesized ${result.synthesized_count} facts, superseded ${result.superseded_count}`,
      );
    } catch (err) {
      this.logger.warn(`Reflect failed: ${String(err)}`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
