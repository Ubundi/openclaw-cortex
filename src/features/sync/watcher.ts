import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { CortexClient } from "../../cortex/client.js";
import type { RetryQueue } from "../../internal/retry-queue.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
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
  captureFilter?: boolean;
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
    private getUserId?: () => string | undefined,
    private auditLogger?: AuditLogger,
  ) {}

  start(): void {
    if (this.started) {
      this.logger.debug?.("File sync: start() called while already running, skipping");
      return;
    }
    this.started = true;

    this.logger.info(`File sync: workspaceDir=${this.workspaceDir}`);

    const memoryMdPath = join(this.workspaceDir, "MEMORY.md");
    const memoryDir = join(this.workspaceDir, "memory");
    const sessionsDir = join(this.workspaceDir, "sessions");
    const fallbackSessionsDir = join(dirname(this.workspaceDir), "agents", "main", "sessions");

    this.memoryMdSync = new MemoryMdSync(
      memoryMdPath,
      this.client,
      `${this.sessionPrefix}:memory-md`,
      this.logger,
      this.retryQueue,
      this.workspaceDir,
      this.getUserId,
      this.auditLogger,
      this.options.captureFilter ?? true,
    );

    this.dailyLogsSync = new DailyLogsSync(
      this.client,
      this.sessionPrefix,
      this.logger,
      this.retryQueue,
      memoryDir,
      this.getUserId,
      this.auditLogger,
      this.options.captureFilter ?? true,
    );

    const watched: string[] = [];
    const failed: string[] = [];

    if (this.watchPath(
      memoryMdPath,
      () => {
        this.memoryMdSync?.onFileChange();
      },
      "File sync: watching MEMORY.md",
      "File sync: MEMORY.md not found, skipping",
    )) {
      watched.push("MEMORY.md");
    } else {
      failed.push("MEMORY.md");
    }

    if (this.watchPath(
      memoryDir,
      (_event, filename) => {
        if (typeof filename !== "string" || !filename.endsWith(".md")) return;
        const fullPath = join(memoryDir, filename);
        this.dailyLogsSync?.onFileChange(fullPath, filename);
      },
      "File sync: watching memory/*.md",
      "File sync: memory/ directory not found, skipping",
      { recursive: true },
    )) {
      watched.push("memory/*.md");
    } else {
      failed.push("memory/*.md");
    }

    // Watch sessions/*.jsonl (transcripts)
    if (this.options.transcripts !== false) {
      const watchTranscriptsAt = (
        rootDir: string,
        watchedLabel: string,
        skipMessage: string,
      ): boolean => {
        const sync = new TranscriptsSync(
          this.client,
          this.sessionPrefix,
          this.logger,
          this.retryQueue,
          rootDir,
          this.getUserId,
          this.auditLogger,
        );
        const started = this.watchPath(
          rootDir,
          (_event, filename) => {
            if (typeof filename !== "string" || !filename.endsWith(".jsonl")) return;
            const fullPath = join(rootDir, filename);
            sync.onFileChange(fullPath, filename);
          },
          `File sync: watching ${watchedLabel}`,
          skipMessage,
          { recursive: true },
        );
        if (started) {
          this.transcriptsSync = sync;
          watched.push(watchedLabel);
        }
        return started;
      };

      if (watchTranscriptsAt(
        sessionsDir,
        "sessions/*.jsonl",
        "File sync: sessions/ directory not found, skipping",
      )) {
        // primary path active
      } else if (watchTranscriptsAt(
        fallbackSessionsDir,
        "agents/main/sessions/*.jsonl",
        "File sync: fallback agent sessions directory not found, skipping",
      )) {
        this.logger.info(`File sync: transcript fallback active (${fallbackSessionsDir})`);
      } else {
        failed.push("sessions/*.jsonl");
      }
    }
    const parts = [`File sync: watching ${watched.length} paths`];
    if (watched.length > 0) parts.push(`(${watched.join(", ")})`);
    if (failed.length > 0) parts.push(`— failed: ${failed.join(", ")}`);
    this.logger.info(parts.join(" "));
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
  ): boolean {
    try {
      const watcher = options ? watch(path, options, handler) : watch(path, handler);
      this.watchers.push(watcher);
      this.logger.info(successMessage);
      return true;
    } catch (err) {
      this.logger.warn(`${skipMessage} (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  }
}
