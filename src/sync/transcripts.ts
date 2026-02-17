import { readFile } from "node:fs/promises";
import type { CortexClient } from "../client.js";
import type { RetryQueue } from "../utils/retry-queue.js";
import { cleanTranscriptChunk } from "../utils/transcript-cleaner.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export class TranscriptsSync {
  private offsets = new Map<string, number>();
  private syncCounter = 0;

  constructor(
    private client: CortexClient,
    private sessionPrefix: string,
    private logger: Logger,
    private retryQueue?: RetryQueue,
  ) {}

  async onFileChange(filePath: string, filename: string): Promise<void> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lastOffset = this.offsets.get(filePath) ?? 0;
      const newContent = content.slice(lastOffset);
      this.offsets.set(filePath, content.length);

      if (!newContent.trim()) return;

      const { messages, worthIngesting } = cleanTranscriptChunk(newContent);

      if (!worthIngesting || messages.length === 0) {
        this.logger.debug?.(`Transcript sync: skipping ${filename} — not enough content`);
        return;
      }

      // Derive session ID from filename (e.g. "abc123.jsonl" → "openclaw:session:abc123")
      const sessionName = filename.replace(/\.jsonl$/, "");
      const sessionId = `${this.sessionPrefix}:session:${sessionName}`;

      const doIngest = () =>
        this.client.ingestConversation(messages, sessionId).then((res) => {
          this.logger.debug?.(
            `Transcript sync: ingested ${res.fact_ids.length} facts from ${filename}`,
          );
        });

      try {
        await doIngest();
      } catch (err) {
        this.logger.warn(`Transcript sync failed for ${filename}, queuing for retry:`, err);
        this.retryQueue?.enqueue(doIngest, `transcript-${filename}-${++this.syncCounter}`);
      }
    } catch (err) {
      this.logger.warn(`Transcript sync read failed for ${filename}:`, err);
    }
  }

  stop(): void {
    this.offsets.clear();
  }
}
