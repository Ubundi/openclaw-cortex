import { readFile } from "node:fs/promises";
import type { CortexClient } from "../../adapters/cortex/client.js";
import type { RetryQueue } from "../../internal/queue/retry-queue.js";
import { safePath } from "../../internal/fs/safe-path.js";

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
      const safe = await safePath(this.filePath, this.allowedRoot);
      if (!safe) {
        this.logger.warn(`MEMORY.md sync: rejected unsafe path ${this.filePath}`);
        return;
      }
      resolvedPath = safe;
    }

    let current: string;
    try {
      current = await readFile(resolvedPath, "utf-8");
    } catch {
      return; // File doesn't exist or unreadable
    }

    if (current === this.lastContent) return;

    const added = lineDiff(this.lastContent, current);
    this.lastContent = current;

    if (!added.trim()) return;

    const doRemember = () => this.client.remember(added, this.sessionId).then((res) => {
      this.logger.debug?.(`MEMORY.md sync: remembered ${res.memories_created} memories`);
    });

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
