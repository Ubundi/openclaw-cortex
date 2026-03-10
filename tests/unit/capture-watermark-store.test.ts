import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CaptureWatermarkStore } from "../../src/internal/capture-watermark-store.js";

describe("CaptureWatermarkStore", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cortex-watermark-test-"));
    filePath = join(tempDir, "watermarks.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns 0 for unknown sessions", async () => {
    const store = new CaptureWatermarkStore(filePath);
    await store.load();
    expect(store.get("unknown-session")).toBe(0);
  });

  it("stores and retrieves watermarks", async () => {
    const store = new CaptureWatermarkStore(filePath);
    await store.load();
    store.set("sess-1", 5);
    expect(store.get("sess-1")).toBe(5);
  });

  it("persists watermarks to disk and reloads them", async () => {
    const store1 = new CaptureWatermarkStore(filePath);
    await store1.load();
    store1.set("sess-1", 10);
    store1.set("sess-2", 20);

    // Wait for the coalesced write
    await new Promise((resolve) => setTimeout(resolve, 700));

    const store2 = new CaptureWatermarkStore(filePath);
    await store2.load();
    expect(store2.get("sess-1")).toBe(10);
    expect(store2.get("sess-2")).toBe(20);
  });

  it("handles missing file on load gracefully", async () => {
    const store = new CaptureWatermarkStore(join(tempDir, "nonexistent.json"));
    await store.load();
    expect(store.get("anything")).toBe(0);
  });

  it("handles corrupted file on load gracefully", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "not valid json!!!", "utf-8");

    const store = new CaptureWatermarkStore(filePath);
    await store.load();
    expect(store.get("anything")).toBe(0);
  });
});
