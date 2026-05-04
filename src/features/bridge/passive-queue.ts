import type { PassiveExtractorMessage } from "./passive.js";

type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

export interface PassiveExtractionJob {
  agentUserId: string;
  sessionKey: string;
  turnIndex: number;
  messages: PassiveExtractorMessage[];
  activeModelRef?: string;
  enqueuedAt: number;
  deadlineAt: number;
}

export interface PassiveExtractionQueueOptions {
  logger: Logger;
  processJob: (job: PassiveExtractionJob) => Promise<void>;
  maxGlobalDepth?: number;
  maxPerUserDepth?: number;
  concurrency?: number;
  autoStart?: boolean;
}

export type PassiveEnqueueResult = {
  enqueued: boolean;
  reason: "enqueued" | "coalesced" | "queue_backpressure" | "session_backpressure";
};

const DEFAULT_MAX_GLOBAL_DEPTH = 100;
const DEFAULT_MAX_PER_USER_DEPTH = 5;
const DEFAULT_CONCURRENCY = 1;

function userSessionKey(job: Pick<PassiveExtractionJob, "agentUserId" | "sessionKey">): string {
  return `${job.agentUserId}:${job.sessionKey}`;
}

export class PassiveExtractionQueue {
  private readonly logger: Logger;
  private readonly processJob: (job: PassiveExtractionJob) => Promise<void>;
  private readonly maxGlobalDepth: number;
  private readonly maxPerUserDepth: number;
  private readonly concurrency: number;
  private readonly autoStart: boolean;
  private readonly pending: PassiveExtractionJob[] = [];
  private readonly activeUserSessions = new Set<string>();
  private activeCount = 0;
  private scheduled = false;
  private drainResolvers: Array<() => void> = [];

  constructor(options: PassiveExtractionQueueOptions) {
    this.logger = options.logger;
    this.processJob = options.processJob;
    this.maxGlobalDepth = options.maxGlobalDepth ?? DEFAULT_MAX_GLOBAL_DEPTH;
    this.maxPerUserDepth = options.maxPerUserDepth ?? DEFAULT_MAX_PER_USER_DEPTH;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.autoStart = options.autoStart ?? true;
  }

  enqueue(job: PassiveExtractionJob): PassiveEnqueueResult {
    const key = userSessionKey(job);
    const existing = this.pending.find((pendingJob) => userSessionKey(pendingJob) === key);
    if (existing) {
      existing.messages = job.messages;
      existing.turnIndex = job.turnIndex;
      existing.activeModelRef = job.activeModelRef;
      existing.deadlineAt = Math.max(existing.deadlineAt, job.deadlineAt);
      this.logger.info(`Cortex bridge: passive_job_enqueued sessionId=${job.sessionKey} reason=coalesced depth=${this.pending.length}`);
      if (this.autoStart) this.schedule();
      return { enqueued: true, reason: "coalesced" };
    }

    if (this.pending.length >= this.maxGlobalDepth) {
      this.logger.warn(`Cortex bridge: passive_job_dropped reason=queue_backpressure sessionId=${job.sessionKey} depth=${this.pending.length}`);
      return { enqueued: false, reason: "queue_backpressure" };
    }

    const pendingForUser = this.pending.filter((pendingJob) => pendingJob.agentUserId === job.agentUserId).length;
    if (pendingForUser >= this.maxPerUserDepth) {
      this.logger.warn(`Cortex bridge: passive_job_dropped reason=session_backpressure sessionId=${job.sessionKey} userDepth=${pendingForUser}`);
      return { enqueued: false, reason: "session_backpressure" };
    }

    this.pending.push(job);
    this.logger.info(`Cortex bridge: passive_job_enqueued sessionId=${job.sessionKey} depth=${this.pending.length}`);
    if (this.autoStart) this.schedule();
    return { enqueued: true, reason: "enqueued" };
  }

  async drain(): Promise<void> {
    this.schedule();
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    while (this.activeCount < this.concurrency) {
      const next = this.takeNextJob();
      if (!next) break;
      void this.runJob(next);
    }
    this.resolveDrainIfIdle();
  }

  private takeNextJob(): PassiveExtractionJob | undefined {
    const now = Date.now();
    for (let index = 0; index < this.pending.length; index += 1) {
      const candidate = this.pending[index];
      if (candidate.deadlineAt <= now) {
        this.pending.splice(index, 1);
        index -= 1;
        this.logger.warn(`Cortex bridge: passive_job_dropped reason=stale sessionId=${candidate.sessionKey}`);
        continue;
      }
      const key = userSessionKey(candidate);
      if (this.activeUserSessions.has(key)) continue;
      this.pending.splice(index, 1);
      return candidate;
    }
    return undefined;
  }

  private async runJob(job: PassiveExtractionJob): Promise<void> {
    const key = userSessionKey(job);
    this.activeCount += 1;
    this.activeUserSessions.add(key);
    try {
      await this.processJob(job);
    } catch {
      this.logger.warn(`Cortex bridge: passive_job_dropped reason=worker_error sessionId=${job.sessionKey}`);
    } finally {
      this.activeUserSessions.delete(key);
      this.activeCount -= 1;
      this.schedule();
      this.resolveDrainIfIdle();
    }
  }

  private isIdle(): boolean {
    return this.pending.length === 0 && this.activeCount === 0;
  }

  private resolveDrainIfIdle(): void {
    if (!this.isIdle()) return;
    const resolvers = this.drainResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }
}
