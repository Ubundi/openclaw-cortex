import { readFile } from "node:fs/promises";
import type { CortexClient } from "../client.js";
import type { RetryQueue } from "../utils/retry-queue.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export class DailyLogsSync {
  private offsets = new Map<string, number>();
  private syncCounter = 0;

  constructor(
    private client: CortexClient,
    private sessionPrefix: string,
    private logger: Logger,
    private retryQueue?: RetryQueue,
  ) {}

  async onFileChange(filePath: string, filename: string): Promise<void> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lastOffset = this.offsets.get(filePath) ?? 0;
      const newContent = content.slice(lastOffset);
      this.offsets.set(filePath, content.length);

      if (!newContent.trim()) return;

      const sessionId = `${this.sessionPrefix}:daily:${filename}`;

      const doIngest = () => this.client.ingest(newContent, sessionId).then(() => {
        this.logger.debug?.(`Daily log sync: ingested from ${filename}`);
      });

      try {
        await doIngest();
      } catch (err) {
        this.logger.warn(`Daily log sync failed for ${filename}, queuing for retry:`, err);
        this.retryQueue?.enqueue(doIngest, `daily-${filename}-${++this.syncCounter}`);
      }
    } catch (err) {
      this.logger.warn(`Daily log sync read failed for ${filename}:`, err);
    }
  }

  stop(): void {
    this.offsets.clear();
  }
}
