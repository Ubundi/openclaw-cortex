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
  private tasksById = new Map<string, RetryTask>();
  private taskOrder: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private taskCounter = 0;
  private isFlushing = false;

  constructor(
    private logger: Logger,
    private maxRetries = MAX_RETRIES,
    private maxCapacity = MAX_CAPACITY,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pendingCount = this.pending;
    if (pendingCount > 0) {
      this.logger.warn(`Retry queue stopped with ${pendingCount} pending tasks`);
    }
    this.tasksById.clear();
    this.taskOrder = [];
    this.isFlushing = false;
  }

  enqueue(execute: () => Promise<void>, label?: string): void {
    const id = label ?? `task-${++this.taskCounter}`;

    // Deduplicate: if a task with the same label exists, replace it
    const existing = this.tasksById.get(id);
    if (existing) {
      existing.execute = execute;
      existing.retries = 0;
      existing.nextAttemptAt = Date.now();
      this.logger.debug?.(`Retry queue: deduplicated ${id}`);
      return;
    }

    // Capacity check: drop oldest task if at limit
    if (this.pending >= this.maxCapacity) {
      const droppedId = this.taskOrder.shift();
      const dropped = droppedId ? this.tasksById.get(droppedId) : undefined;
      if (droppedId) {
        this.tasksById.delete(droppedId);
      }
      this.logger.warn(
        `Retry queue: at capacity (${this.maxCapacity}), dropped oldest task ${dropped?.id ?? "unknown"}`,
      );
    }

    this.tasksById.set(id, {
      id,
      execute,
      retries: 0,
      nextAttemptAt: Date.now(),
    });
    this.taskOrder.push(id);
    this.logger.debug?.(`Retry queue: enqueued ${id}`);
  }

  get pending(): number {
    return this.tasksById.size;
  }

  private async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    const now = Date.now();
    const ids = [...this.taskOrder];

    try {
      for (const id of ids) {
        const task = this.tasksById.get(id);
        if (!task || task.nextAttemptAt > now) continue;

        try {
          await task.execute();
          this.remove(id);
          this.logger.debug?.(`Retry queue: ${task.id} succeeded`);
        } catch (err) {
          task.retries++;
          if (task.retries >= this.maxRetries) {
            this.remove(id);
            this.logger.warn(
              `Retry queue: ${task.id} failed after ${this.maxRetries} retries, dropping: ${String(err)}`,
            );
          } else {
            const delay = Math.min(
              BASE_DELAY_MS * Math.pow(2, task.retries),
              MAX_DELAY_MS,
            );
            task.nextAttemptAt = Date.now() + delay;
            this.logger.debug?.(
              `Retry queue: ${task.id} retry ${task.retries}/${this.maxRetries} in ${delay}ms`,
            );
          }
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private remove(id: string): void {
    if (!this.tasksById.delete(id)) return;
    const idx = this.taskOrder.indexOf(id);
    if (idx !== -1) {
      this.taskOrder.splice(idx, 1);
    }
  }
}
