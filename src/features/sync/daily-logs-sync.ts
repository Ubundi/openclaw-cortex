import { readFile } from "node:fs/promises";
import type { CortexClient } from "../../cortex/client.js";
import type { RetryQueue } from "../../shared/queue/retry-queue.js";
import { safePath } from "../../shared/fs/safe-path.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export class DailyLogsSync {
  private offsets = new Map<string, number>();

  constructor(
    private client: CortexClient,
    private sessionPrefix: string,
    private logger: Logger,
    private retryQueue?: RetryQueue,
    private allowedRoot?: string,
  ) {}

  async onFileChange(filePath: string, filename: string): Promise<void> {
    try {
      if (this.allowedRoot) {
        const safe = await safePath(filePath, this.allowedRoot);
        if (!safe) {
          this.logger.warn(`Daily log sync: rejected unsafe path ${filePath}`);
          return;
        }
        filePath = safe;
      }

      const content = await readFile(filePath, "utf-8");
      const lastOffset = this.offsets.get(filePath) ?? 0;
      const newContent = content.slice(lastOffset);
      this.offsets.set(filePath, content.length);

      if (!newContent.trim()) return;

      const sessionId = `${this.sessionPrefix}:daily:${filename}`;
      const referenceDate = extractDateFromFilename(filename);

      const doIngest = () => this.client.ingest(newContent, sessionId, undefined, referenceDate).then(() => {
        this.logger.debug?.(`Daily log sync: ingested from ${filename}`);
      });

      try {
        await doIngest();
      } catch (err) {
        this.logger.warn(`Daily log sync failed for ${filename}, queuing for retry: ${String(err)}`);
        this.retryQueue?.enqueue(doIngest, `daily-${filename}`);
      }
    } catch (err) {
      this.logger.warn(`Daily log sync read failed for ${filename}: ${String(err)}`);
    }
  }

  stop(): void {
    this.offsets.clear();
  }
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

export function extractDateFromFilename(filename: string): string | undefined {
  const match = DATE_RE.exec(filename);
  return match?.[1];
}
