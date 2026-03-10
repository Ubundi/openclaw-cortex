import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_WATERMARK_FILE = join(homedir(), ".openclaw", "cortex-capture-watermarks.json");

/** Max entries to keep — evicts oldest when exceeded */
const MAX_ENTRIES = 500;

interface WatermarkData {
  [sessionKey: string]: number;
}

/**
 * Persists per-session capture watermarks to disk so they survive process restarts.
 * Without this, every cold start re-sends the full message history.
 */
export class CaptureWatermarkStore {
  private data: WatermarkData | null = null;
  private dirty = false;
  private writeScheduled = false;

  constructor(private readonly filePath: string = DEFAULT_WATERMARK_FILE) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        this.data = parsed as WatermarkData;
      } else {
        this.data = {};
      }
    } catch {
      this.data = {};
    }
  }

  get(sessionKey: string): number {
    return this.data?.[sessionKey] ?? 0;
  }

  set(sessionKey: string, watermark: number): void {
    if (!this.data) this.data = {};
    this.data[sessionKey] = watermark;
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    // Coalesce rapid updates into a single write
    setTimeout(() => {
      this.writeScheduled = false;
      if (this.dirty) {
        void this.save();
      }
    }, 500);
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    this.dirty = false;

    // Evict oldest entries if over capacity
    const keys = Object.keys(this.data);
    if (keys.length > MAX_ENTRIES) {
      const sorted = keys.sort((a, b) => (this.data![a] ?? 0) - (this.data![b] ?? 0));
      const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES);
      for (const key of toRemove) {
        delete this.data[key];
      }
    }

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data), "utf-8");
    } catch {
      // Non-fatal — watermarks are a performance optimization, not critical data
    }
  }
}
