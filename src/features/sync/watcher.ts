import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { CortexClient } from "../../adapters/cortex/client.js";
import type { RetryQueue } from "../../internal/queue/retry-queue.js";
import { MemoryMdSync } from "./memory-md-sync.js";
import { DailyLogsSync } from "./daily-logs-sync.js";
import { TranscriptsSync } from "./transcripts-sync.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export interface FileSyncOptions {
  transcripts?: boolean;
}

export class FileSyncWatcher {
  private watchers: FSWatcher[] = [];
  private memoryMdSync: MemoryMdSync | null = null;
  private dailyLogsSync: DailyLogsSync | null = null;
  private transcriptsSync: TranscriptsSync | null = null;
  private started = false;

  constructor(
    private workspaceDir: string,
    private client: CortexClient,
    private sessionPrefix: string,
    private logger: Logger,
    private retryQueue?: RetryQueue,
    private options: FileSyncOptions = {},
  ) {}

  start(): void {
    if (this.started) {
      this.logger.debug?.("File sync: start() called while already running, skipping");
      return;
    }
    this.started = true;

    const memoryMdPath = join(this.workspaceDir, "MEMORY.md");
    const memoryDir = join(this.workspaceDir, "memory");
    const sessionsDir = join(this.workspaceDir, "sessions");

    this.memoryMdSync = new MemoryMdSync(
      memoryMdPath,
      this.client,
      `${this.sessionPrefix}:memory-md`,
      this.logger,
      this.retryQueue,
      this.workspaceDir,
    );

    this.dailyLogsSync = new DailyLogsSync(
      this.client,
      this.sessionPrefix,
      this.logger,
      this.retryQueue,
      memoryDir,
    );

    this.watchPath(
      memoryMdPath,
      () => {
        this.memoryMdSync?.onFileChange();
      },
      "File sync: watching MEMORY.md",
      "File sync: MEMORY.md not found, skipping",
    );

    this.watchPath(
      memoryDir,
      (_event, filename) => {
        if (typeof filename !== "string" || !filename.endsWith(".md")) return;
        const fullPath = join(memoryDir, filename);
        this.dailyLogsSync?.onFileChange(fullPath, filename);
      },
      "File sync: watching memory/*.md",
      "File sync: memory/ directory not found, skipping",
      { recursive: true },
    );

    // Watch sessions/*.jsonl (transcripts)
    if (this.options.transcripts !== false) {
      this.transcriptsSync = new TranscriptsSync(
        this.client,
        this.sessionPrefix,
        this.logger,
        this.retryQueue,
        sessionsDir,
      );
      this.watchPath(
        sessionsDir,
        (_event, filename) => {
          if (typeof filename !== "string" || !filename.endsWith(".jsonl")) return;
          const fullPath = join(sessionsDir, filename);
          this.transcriptsSync?.onFileChange(fullPath, filename);
        },
        "File sync: watching sessions/*.jsonl",
        "File sync: sessions/ directory not found, skipping",
        { recursive: true },
      );
    }
  }

  stop(): void {
    if (!this.started) {
      this.logger.info("File sync stopped");
      return;
    }
    this.started = false;

    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    this.memoryMdSync?.stop();
    this.dailyLogsSync?.stop();
    this.transcriptsSync?.stop();
    this.logger.info("File sync stopped");
  }

  private watchPath(
    path: string,
    handler: (event: string, filename: string | Buffer | null) => void,
    successMessage: string,
    skipMessage: string,
    options?: { recursive: true },
  ): void {
    try {
      const watcher = options ? watch(path, options, handler) : watch(path, handler);
      this.watchers.push(watcher);
      this.logger.debug?.(successMessage);
    } catch {
      this.logger.debug?.(skipMessage);
    }
  }
}
