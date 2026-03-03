import { readFile } from "node:fs/promises";
import type { CortexClient } from "../../adapters/cortex/client.js";
import type { RetryQueue } from "../../internal/queue/retry-queue.js";
import type { AuditLogger } from "../../internal/audit/audit-logger.js";
import { safePath } from "../../internal/fs/safe-path.js";
import { filterLowSignalLines } from "../capture/filter.js";

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
    private getUserId?: () => string | undefined,
    private auditLogger?: AuditLogger,
    private captureFilter = true,
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
      let newContent = content.slice(lastOffset);
      this.offsets.set(filePath, content.length);

      if (this.captureFilter) {
        newContent = filterLowSignalLines(newContent);
      }

      if (!newContent.trim()) return;

      const sessionId = `${this.sessionPrefix}:daily:${filename}`;
      const referenceDate = extractDateFromFilename(filename);

      if (this.auditLogger) {
        void this.auditLogger.log({
          feature: "file-sync-daily-logs",
          method: "POST",
          endpoint: "/v1/remember",
          payload: newContent,
          sessionId,
          userId: this.getUserId?.(),
        });
      }

      const doRemember = () => {
        // Re-evaluate userId at call time so retries use the resolved value
        const userId = this.getUserId?.();
        return this.client.remember(
          newContent,
          sessionId,
          undefined,
          referenceDate,
          userId,
          "openclaw",
          "OpenClaw",
        ).then((res) => {
          this.logger.debug?.(`Daily log sync: remembered ${res.memories_created} memories for ${filename}`);
        });
      };

      try {
        await doRemember();
      } catch (err) {
        this.logger.warn(`Daily log sync failed for ${filename}, queuing for retry: ${String(err)}`);
        this.retryQueue?.enqueue(doRemember, `daily-${filename}`);
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
