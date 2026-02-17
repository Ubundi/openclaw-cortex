const DEFAULT_WINDOW_SIZE = 100;

export class LatencyMetrics {
  private samples: number[] = [];
  private windowSize: number;

  constructor(windowSize = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  record(durationMs: number): void {
    this.samples.push(durationMs);
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
  }

  get count(): number {
    return this.samples.length;
  }

  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  get p50(): number | null {
    return this.percentile(50);
  }

  get p95(): number | null {
    return this.percentile(95);
  }

  get p99(): number | null {
    return this.percentile(99);
  }

  summary(): { count: number; p50: number | null; p95: number | null; p99: number | null } {
    return {
      count: this.count,
      p50: this.p50,
      p95: this.p95,
      p99: this.p99,
    };
  }

  reset(): void {
    this.samples = [];
  }
}
