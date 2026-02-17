import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { CortexClient } from "../client.js";
import { MemoryMdSync } from "./memory-md.js";
import { DailyLogsSync } from "./daily-logs.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export class FileSyncWatcher {
  private watchers: FSWatcher[] = [];
  private memoryMdSync: MemoryMdSync | null = null;
  private dailyLogsSync: DailyLogsSync | null = null;

  constructor(
    private workspaceDir: string,
    private client: CortexClient,
    private sessionPrefix: string,
    private logger: Logger,
  ) {}

  start(): void {
    const memoryMdPath = join(this.workspaceDir, "MEMORY.md");
    const memoryDir = join(this.workspaceDir, "memory");

    this.memoryMdSync = new MemoryMdSync(
      memoryMdPath,
      this.client,
      `${this.sessionPrefix}:memory-md`,
      this.logger,
    );

    this.dailyLogsSync = new DailyLogsSync(
      this.client,
      this.sessionPrefix,
      this.logger,
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
  }

  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    this.memoryMdSync?.stop();
    this.dailyLogsSync?.stop();
    this.logger.info("File sync stopped");
  }
}
