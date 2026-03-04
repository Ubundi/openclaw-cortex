import { readFile } from "node:fs/promises";
import type { CortexClient } from "../../adapters/cortex/client.js";
import type { RetryQueue } from "../../internal/queue/retry-queue.js";
import type { AuditLogger } from "../../internal/audit/audit-logger.js";
import { safePathCheck } from "../../internal/fs/safe-path.js";
import { filterLowSignalLines } from "../capture/filter.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

const DEBOUNCE_MS = 2000;

export class MemoryMdSync {
  private lastContent = "";
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncCounter = 0;

  constructor(
    private filePath: string,
    private client: CortexClient,
    private sessionId: string,
    private logger: Logger,
    private retryQueue?: RetryQueue,
    private allowedRoot?: string,
    private getUserId?: () => string | undefined,
    private auditLogger?: AuditLogger,
    private captureFilter = true,
  ) {}

  onFileChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.diffAndIngest().catch((err) => {
        this.logger.warn(`MEMORY.md sync failed: ${String(err)}`);
      });
    }, DEBOUNCE_MS);
  }

  private async diffAndIngest(): Promise<void> {
    let resolvedPath = this.filePath;

    if (this.allowedRoot) {
      const safe = await safePathCheck(this.filePath, this.allowedRoot);
      if (!safe.ok) {
        if (safe.reason === "unsafe") {
          this.logger.warn(`MEMORY.md sync: rejected unsafe path ${this.filePath}`);
        } else if (safe.reason === "io_error") {
          this.logger.warn(`MEMORY.md sync: path check failed for ${this.filePath} (${safe.errorCode ?? "unknown"})`);
        } else {
          this.logger.debug?.(`MEMORY.md sync: file not found during path check ${this.filePath}`);
        }
        return;
      }
      resolvedPath = safe.path;
    }

    let current: string;
    try {
      current = await readFile(resolvedPath, "utf-8");
    } catch {
      return; // File doesn't exist or unreadable
    }

    if (current === this.lastContent) return;

    let added = lineDiff(this.lastContent, current);
    this.lastContent = current;

    if (this.captureFilter) {
      added = filterLowSignalLines(added);
    }

    if (!added.trim()) return;

    if (this.auditLogger) {
      void this.auditLogger.log({
        feature: "file-sync-memory-md",
        method: "POST",
        endpoint: "/v1/remember",
        payload: added,
        sessionId: this.sessionId,
        userId: this.getUserId?.(),
      });
    }

    const doRemember = () => {
      // Re-evaluate userId at call time so retries use the resolved value
      const userId = this.getUserId?.();
      if (this.getUserId && !userId) {
        this.logger.warn("MEMORY.md sync: missing user_id, retrying later");
        throw new Error("Cortex ingest requires user_id");
      }
      return this.client.remember(
        added,
        this.sessionId,
        undefined,
        undefined,
        userId,
        "openclaw",
        "OpenClaw",
      ).then(() => {
        this.logger.debug?.("MEMORY.md sync: remember accepted");
      });
    };

    try {
      await doRemember();
    } catch (err) {
      this.logger.warn(`MEMORY.md sync failed, queuing for retry: ${String(err)}`);
      this.retryQueue?.enqueue(doRemember, `memory-md-${++this.syncCounter}`);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

export function lineDiff(previous: string, current: string): string {
  const prevLines = new Set(previous.split("\n"));
  return current
    .split("\n")
    .filter((line) => !prevLines.has(line))
    .join("\n");
}
