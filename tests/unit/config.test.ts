import { describe, it, expect } from "vitest";
import { CortexConfigSchema } from "../../src/plugin/config/schema.js";

describe("CortexConfigSchema", () => {
  const validBase = { apiKey: "sk-test" };

  describe("HTTPS enforcement", () => {
    it("accepts HTTPS URLs", () => {
      const result = CortexConfigSchema.safeParse({
        ...validBase,
        baseUrl: "https://api.example.com",
      });
      expect(result.success).toBe(true);
    });

    it("rejects plain HTTP URLs", () => {
      const result = CortexConfigSchema.safeParse({
        ...validBase,
        baseUrl: "http://api.example.com",
      });
      expect(result.success).toBe(false);
    });

    it("allows http://localhost for development", () => {
      const result = CortexConfigSchema.safeParse({
        ...validBase,
        baseUrl: "http://localhost:8080",
      });
      expect(result.success).toBe(true);
    });

    it("allows http://127.0.0.1 for development", () => {
      const result = CortexConfigSchema.safeParse({
        ...validBase,
        baseUrl: "http://127.0.0.1:3000",
      });
      expect(result.success).toBe(true);
    });

    it("rejects http with non-localhost host", () => {
      const result = CortexConfigSchema.safeParse({
        ...validBase,
        baseUrl: "http://192.168.1.1:8080",
      });
      expect(result.success).toBe(false);
    });

    it("uses HTTPS default when baseUrl is omitted", () => {
      const result = CortexConfigSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.baseUrl).toMatch(/^https:/);
      }
    });
  });

  describe("namespace config", () => {
    it("defaults namespace to 'openclaw'", () => {
      const result = CortexConfigSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.namespace).toBe("openclaw");
      }
    });

    it("accepts custom namespace", () => {
      const result = CortexConfigSchema.safeParse({
        ...validBase,
        namespace: "my-project",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.namespace).toBe("my-project");
      }
    });

    it("rejects empty namespace", () => {
      const result = CortexConfigSchema.safeParse({
        ...validBase,
        namespace: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("field validation", () => {
    it("rejects empty apiKey", () => {
      const result = CortexConfigSchema.safeParse({ apiKey: "" });
      expect(result.success).toBe(false);
    });

    it("rejects recallLimit below 1", () => {
      const result = CortexConfigSchema.safeParse({ ...validBase, recallLimit: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects recallLimit above 50", () => {
      const result = CortexConfigSchema.safeParse({ ...validBase, recallLimit: 51 });
      expect(result.success).toBe(false);
    });

    it("rejects recallTimeoutMs below 100", () => {
      const result = CortexConfigSchema.safeParse({ ...validBase, recallTimeoutMs: 99 });
      expect(result.success).toBe(false);
    });

    it("rejects recallTimeoutMs above 10000", () => {
      const result = CortexConfigSchema.safeParse({ ...validBase, recallTimeoutMs: 10001 });
      expect(result.success).toBe(false);
    });

    it("applies all defaults with only apiKey", () => {
      const result = CortexConfigSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoRecall).toBe(true);
        expect(result.data.autoCapture).toBe(true);
        expect(result.data.recallLimit).toBe(10);
        expect(result.data.recallTimeoutMs).toBe(2000);
        expect(result.data.fileSync).toBe(true);
        expect(result.data.transcriptSync).toBe(true);
        expect(result.data.namespace).toBe("openclaw");
      }
    });
  });
});
