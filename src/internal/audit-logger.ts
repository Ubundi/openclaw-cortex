import { mkdir, appendFile, writeFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export interface AuditEntry {
  feature: string;
  method: string;
  endpoint: string;
  payload: string;
  sessionId?: string;
  userId?: string;
  messageCount?: number;
}

const MAX_INDEX_BYTES = 5 * 1024 * 1024; // 5MB

export class AuditLogger {
  private readonly auditDir: string;
  private readonly payloadsDir: string;
  private readonly indexPath: string;
  private counter = 0;
  private initialized = false;

  constructor(
    workspaceDir: string,
    private readonly logger: Logger,
  ) {
    this.auditDir = join(workspaceDir, ".cortex", "audit");
    this.payloadsDir = join(this.auditDir, "payloads");
    this.indexPath = join(this.auditDir, "index.jsonl");
  }

  async log(entry: AuditEntry): Promise<void> {
    try {
      if (!this.initialized) {
        await mkdir(this.payloadsDir, { recursive: true });
        this.initialized = true;
      }

      const ts = new Date().toISOString();
      const seq = String(++this.counter).padStart(3, "0");
      const payloadFilename = `${ts.replace(/[:.]/g, "")}-${seq}.txt`;
      const payloadPath = join(this.payloadsDir, payloadFilename);

      await writeFile(payloadPath, entry.payload, { encoding: "utf-8", mode: 0o600 });

      const indexLine: Record<string, unknown> = {
        ts,
        feature: entry.feature,
        method: entry.method,
        endpoint: entry.endpoint,
        bytes: Buffer.byteLength(entry.payload, "utf-8"),
        sessionId: entry.sessionId,
        userId: entry.userId,
        payloadFile: payloadFilename,
      };
      if (entry.messageCount !== undefined) {
        indexLine.msgs = entry.messageCount;
      }

      await appendFile(this.indexPath, JSON.stringify(indexLine) + "\n", "utf-8");

      await this.rotateIfNeeded();
    } catch (err) {
      this.logger.warn(`Cortex audit log write failed: ${String(err)}`);
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stats = await stat(this.indexPath);
      if (stats.size > MAX_INDEX_BYTES) {
        const rotatedPath = join(this.auditDir, `index.${Date.now()}.jsonl`);
        await rename(this.indexPath, rotatedPath);
      }
    } catch {
      // File may not exist yet or stat failed — ignore
    }
  }
}
