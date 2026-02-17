import { describe, it, expect } from "vitest";
import { LatencyMetrics } from "../../src/shared/metrics/latency-metrics.js";

describe("LatencyMetrics", () => {
  it("computes percentiles correctly", () => {
    const m = new LatencyMetrics();

    // Add 100 samples: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      m.record(i);
    }

    expect(m.count).toBe(100);
    expect(m.p50).toBe(50);
    expect(m.p95).toBe(95);
    expect(m.p99).toBe(99);
  });

  it("returns null for empty metrics", () => {
    const m = new LatencyMetrics();
    expect(m.p50).toBeNull();
    expect(m.p95).toBeNull();
    expect(m.p99).toBeNull();
  });

  it("respects rolling window size", () => {
    const m = new LatencyMetrics(5);

    for (let i = 1; i <= 10; i++) {
      m.record(i);
    }

    // Only last 5 samples: 6, 7, 8, 9, 10
    expect(m.count).toBe(5);
    expect(m.p50).toBe(8);
  });

  it("summary returns all metrics", () => {
    const m = new LatencyMetrics();
    m.record(100);
    m.record(200);

    const s = m.summary();
    expect(s.count).toBe(2);
    expect(s.p50).toBe(100);
    expect(s.p95).toBe(200);
    expect(s.p99).toBe(200);
  });

  it("reset clears all samples", () => {
    const m = new LatencyMetrics();
    m.record(50);
    m.reset();
    expect(m.count).toBe(0);
    expect(m.p50).toBeNull();
  });

  it("summary returns all nulls after reset", () => {
    const m = new LatencyMetrics();
    m.record(100);
    m.reset();
    const s = m.summary();
    expect(s).toEqual({ count: 0, p50: null, p95: null, p99: null });
  });

  it("percentile(100) returns the maximum", () => {
    const m = new LatencyMetrics();
    for (let i = 1; i <= 10; i++) m.record(i);
    expect(m.p99).toBe(10); // p99 of 10 items = index 9 = max
  });

  it("windowSize of 1 keeps only the last sample", () => {
    const m = new LatencyMetrics(1);
    m.record(100);
    m.record(200);
    expect(m.count).toBe(1);
    expect(m.p50).toBe(200);
  });
});
