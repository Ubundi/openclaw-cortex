type Logger = {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export interface RetryTask {
  id: string;
  execute: () => Promise<void>;
  retries: number;
  nextAttemptAt: number;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const MAX_RETRIES = 5;
const MAX_CAPACITY = 100;
const FLUSH_INTERVAL_MS = 5000;

export class RetryQueue {
  private queue: RetryTask[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private taskCounter = 0;

  constructor(
    private logger: Logger,
    private maxRetries = MAX_RETRIES,
    private maxCapacity = MAX_CAPACITY,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.queue.length > 0) {
      this.logger.warn(`Retry queue stopped with ${this.queue.length} pending tasks`);
    }
    this.queue = [];
  }

  enqueue(execute: () => Promise<void>, label?: string): void {
    const id = label ?? `task-${++this.taskCounter}`;

    // Deduplicate: if a task with the same label exists, replace it
    const existingIdx = this.queue.findIndex((t) => t.id === id);
    if (existingIdx !== -1) {
      this.queue[existingIdx].execute = execute;
      this.queue[existingIdx].retries = 0;
      this.queue[existingIdx].nextAttemptAt = Date.now();
      this.logger.debug?.(`Retry queue: deduplicated ${id}`);
      return;
    }

    // Capacity check: drop oldest task if at limit
    if (this.queue.length >= this.maxCapacity) {
      const dropped = this.queue.shift()!;
      this.logger.warn(
        `Retry queue: at capacity (${this.maxCapacity}), dropped oldest task ${dropped.id}`,
      );
    }

    this.queue.push({
      id,
      execute,
      retries: 0,
      nextAttemptAt: Date.now(),
    });
    this.logger.debug?.(`Retry queue: enqueued ${id}`);
  }

  get pending(): number {
    return this.queue.length;
  }

  private async flush(): Promise<void> {
    const now = Date.now();
    const ready = this.queue.filter((t) => t.nextAttemptAt <= now);

    for (const task of ready) {
      try {
        await task.execute();
        this.queue = this.queue.filter((t) => t.id !== task.id);
        this.logger.debug?.(`Retry queue: ${task.id} succeeded`);
      } catch (err) {
        task.retries++;
        if (task.retries >= this.maxRetries) {
          this.queue = this.queue.filter((t) => t.id !== task.id);
          this.logger.warn(
            `Retry queue: ${task.id} failed after ${this.maxRetries} retries, dropping: ${String(err)}`,
          );
        } else {
          const delay = Math.min(
            BASE_DELAY_MS * Math.pow(2, task.retries),
            MAX_DELAY_MS,
          );
          task.nextAttemptAt = now + delay;
          this.logger.debug?.(
            `Retry queue: ${task.id} retry ${task.retries}/${this.maxRetries} in ${delay}ms`,
          );
        }
      }
    }
  }
}
