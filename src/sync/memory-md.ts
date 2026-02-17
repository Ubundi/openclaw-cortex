import { readFile } from "node:fs/promises";
import type { CortexClient } from "../client.js";

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

  constructor(
    private filePath: string,
    private client: CortexClient,
    private sessionId: string,
    private logger: Logger,
  ) {}

  onFileChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.diffAndIngest().catch((err) => {
        this.logger.warn("MEMORY.md sync failed:", err);
      });
    }, DEBOUNCE_MS);
  }

  private async diffAndIngest(): Promise<void> {
    let current: string;
    try {
      current = await readFile(this.filePath, "utf-8");
    } catch {
      return; // File doesn't exist or unreadable
    }

    if (current === this.lastContent) return;

    const added = lineDiff(this.lastContent, current);
    this.lastContent = current;

    if (!added.trim()) return;

    try {
      await this.client.ingest(added, this.sessionId);
      this.logger.debug?.("MEMORY.md sync: ingested diff");
    } catch (err) {
      this.logger.warn("MEMORY.md sync ingest failed:", err);
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
