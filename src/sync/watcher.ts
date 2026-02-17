import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { CortexClient } from "../client.js";
import type { RetryQueue } from "../utils/retry-queue.js";
import { MemoryMdSync } from "./memory-md.js";
import { DailyLogsSync } from "./daily-logs.js";
import { TranscriptsSync } from "./transcripts.js";

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

  constructor(
    private workspaceDir: string,
    private client: CortexClient,
    private sessionPrefix: string,
    private logger: Logger,
    private retryQueue?: RetryQueue,
    private options: FileSyncOptions = {},
  ) {}

  start(): void {
    const memoryMdPath = join(this.workspaceDir, "MEMORY.md");
    const memoryDir = join(this.workspaceDir, "memory");
    const sessionsDir = join(this.workspaceDir, "sessions");

    this.memoryMdSync = new MemoryMdSync(
      memoryMdPath,
      this.client,
      `${this.sessionPrefix}:memory-md`,
      this.logger,
      this.retryQueue,
    );

    this.dailyLogsSync = new DailyLogsSync(
      this.client,
      this.sessionPrefix,
      this.logger,
      this.retryQueue,
    );

    // Watch MEMORY.md
    try {
      const memWatcher = watch(memoryMdPath, () => {
        this.memoryMdSync?.onFileChange();
      });
      this.watchers.push(memWatcher);
      this.logger.debug?.("File sync: watching MEMORY.md");
    } catch {
      this.logger.debug?.("File sync: MEMORY.md not found, skipping");
    }

    // Watch memory/*.md (daily logs)
    try {
      const logsWatcher = watch(
        memoryDir,
        { recursive: true },
        (_event, filename) => {
          if (!filename?.endsWith(".md")) return;
          const fullPath = join(memoryDir, filename);
          this.dailyLogsSync?.onFileChange(fullPath, filename);
        },
      );
      this.watchers.push(logsWatcher);
      this.logger.debug?.("File sync: watching memory/*.md");
    } catch {
      this.logger.debug?.("File sync: memory/ directory not found, skipping");
    }

    // Watch sessions/*.jsonl (transcripts)
    if (this.options.transcripts !== false) {
      this.transcriptsSync = new TranscriptsSync(
        this.client,
        this.sessionPrefix,
        this.logger,
        this.retryQueue,
      );

      try {
        const sessionsWatcher = watch(
          sessionsDir,
          { recursive: true },
          (_event, filename) => {
            if (!filename?.endsWith(".jsonl")) return;
            const fullPath = join(sessionsDir, filename);
            this.transcriptsSync?.onFileChange(fullPath, filename);
          },
        );
        this.watchers.push(sessionsWatcher);
        this.logger.debug?.("File sync: watching sessions/*.jsonl");
      } catch {
        this.logger.debug?.("File sync: sessions/ directory not found, skipping");
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    this.memoryMdSync?.stop();
    this.dailyLogsSync?.stop();
    this.transcriptsSync?.stop();
    this.logger.info("File sync stopped");
  }
}
