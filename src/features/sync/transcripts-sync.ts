import { readFile } from "node:fs/promises";
import type { CortexClient } from "../../cortex/client.js";
import type { RetryQueue } from "../../shared/queue/retry-queue.js";
import { cleanTranscriptChunk } from "../../shared/transcript/cleaner.js";
import { safePath } from "../../shared/fs/safe-path.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export class TranscriptsSync {
  private offsets = new Map<string, number>();

  constructor(
    private client: CortexClient,
    private sessionPrefix: string,
    private logger: Logger,
    private retryQueue?: RetryQueue,
    private allowedRoot?: string,
  ) {}

  async onFileChange(filePath: string, filename: string): Promise<void> {
    try {
      if (this.allowedRoot) {
        const safe = await safePath(filePath, this.allowedRoot);
        if (!safe) {
          this.logger.warn(`Transcript sync: rejected unsafe path ${filePath}`);
          return;
        }
        filePath = safe;
      }

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

      const referenceDate = new Date().toISOString().slice(0, 10);

      const doIngest = () =>
        this.client.submitIngestConversation(messages, sessionId, referenceDate).then((res) => {
          this.logger.debug?.(`Transcript sync: submitted ingest job ${res.job_id} for ${filename}`);
        });

      try {
        await doIngest();
      } catch (err) {
        this.logger.warn(`Transcript sync failed for ${filename}, queuing for retry: ${String(err)}`);
        this.retryQueue?.enqueue(doIngest, `transcript-${filename}`);
      }
    } catch (err) {
      this.logger.warn(`Transcript sync read failed for ${filename}: ${String(err)}`);
    }
  }

  stop(): void {
    this.offsets.clear();
  }
}
