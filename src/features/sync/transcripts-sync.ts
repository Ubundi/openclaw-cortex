import { readFile } from "node:fs/promises";
import type { CortexClient } from "../../cortex/client.js";
import type { RetryQueue } from "../../internal/retry-queue.js";
import type { AuditLogger } from "../../internal/audit-logger.js";
import { cleanTranscriptChunk } from "../../internal/cleaner.js";
import { safePathCheck } from "../../internal/safe-path.js";

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
    private getUserId?: () => string | undefined,
    private auditLogger?: AuditLogger,
  ) {}

  async onFileChange(filePath: string, filename: string): Promise<void> {
    try {
      if (this.allowedRoot) {
        const safe = await safePathCheck(filePath, this.allowedRoot);
        if (!safe.ok) {
          if (safe.reason === "unsafe") {
            this.logger.warn(`Transcript sync: rejected unsafe path ${filePath}`);
          } else if (safe.reason === "io_error") {
            this.logger.warn(`Transcript sync: path check failed for ${filePath} (${safe.errorCode ?? "unknown"})`);
          } else {
            this.logger.debug?.(`Transcript sync: file not found during path check ${filePath}`);
          }
          return;
        }
        filePath = safe.path;
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

      if (this.auditLogger) {
        void this.auditLogger.log({
          feature: "file-sync-transcripts",
          method: "POST",
          endpoint: "/v1/remember",
          payload: messages.map((m) => `${m.role}: ${m.content}`).join("\n\n"),
          sessionId,
          userId: this.getUserId?.(),
          messageCount: messages.length,
        });
      }

      const doRemember = () => {
        // Re-evaluate userId at call time so retries use the resolved value
        const userId = this.getUserId?.();
        if (this.getUserId && !userId) {
          this.logger.warn(`Transcript sync: missing user_id for ${filename}, retrying later`);
          throw new Error("Cortex ingest requires user_id");
        }
        return this.client.rememberConversation(
          messages,
          sessionId,
          undefined,
          referenceDate,
          userId,
          "openclaw",
          "OpenClaw",
        ).then(() => {
          this.logger.debug?.(`Transcript sync: remember accepted for ${filename}`);
        });
      };

      try {
        await doRemember();
      } catch (err) {
        this.logger.warn(`Transcript sync failed for ${filename}, queuing for retry: ${String(err)}`);
        this.retryQueue?.enqueue(doRemember, `transcript-${filename}`);
      }
    } catch (err) {
      this.logger.warn(`Transcript sync read failed for ${filename}: ${String(err)}`);
    }
  }

  stop(): void {
    this.offsets.clear();
  }
}
