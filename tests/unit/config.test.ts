import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CortexConfigSchema } from "../../src/plugin/config.js";

describe("CortexConfigSchema", () => {
  const validBase = {};

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

    it("rejects recallTimeoutMs above 120000", () => {
      const result = CortexConfigSchema.safeParse({ ...validBase, recallTimeoutMs: 120001 });
      expect(result.success).toBe(false);
    });

    it("applies all defaults with empty config", () => {
      const result = CortexConfigSchema.safeParse(validBase);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.autoRecall).toBe(true);
        expect(result.data.autoCapture).toBe(true);
        expect(result.data.recallLimit).toBe(20);
        expect(result.data.recallTopK).toBe(10);
        expect(result.data.recallQueryType).toBe("combined");
        expect(result.data.recallTimeoutMs).toBe(60000);
        expect(result.data.namespace).toBe("openclaw");
      }
    });
  });

  describe("manifest parity", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "../../openclaw.plugin.json"), "utf-8"),
    );
    const manifestProps = manifest.configSchema.properties;
    const zodDefaults = CortexConfigSchema.safeParse({});

    // Fields that are intentionally optional in Zod and omitted from manifest defaults
    const optionalFields = new Set(["userId", "recallReferenceDate"]);

    it("manifest configSchema has every Zod field", () => {
      if (!zodDefaults.success) throw new Error("Zod parse failed");
      const zodKeys = Object.keys(zodDefaults.data);
      for (const key of zodKeys) {
        expect(manifestProps, `manifest missing field: ${key}`).toHaveProperty(key);
      }
    });

    it("manifest has no extra fields beyond Zod schema", () => {
      if (!zodDefaults.success) throw new Error("Zod parse failed");
      const zodShape = CortexConfigSchema.shape;
      for (const key of Object.keys(manifestProps)) {
        expect(zodShape, `manifest has extra field not in Zod: ${key}`).toHaveProperty(key);
      }
    });

    it("manifest defaults match Zod defaults", () => {
      if (!zodDefaults.success) throw new Error("Zod parse failed");
      for (const [key, value] of Object.entries(zodDefaults.data)) {
        if (optionalFields.has(key)) continue;
        const manifestDefault = manifestProps[key]?.default;
        expect(manifestDefault, `default mismatch for ${key}: manifest=${manifestDefault}, zod=${value}`).toEqual(value);
      }
    });

    it("manifest has uiHints for every config field", () => {
      for (const key of Object.keys(manifestProps)) {
        if (optionalFields.has(key)) continue;
        expect(manifest.uiHints, `missing uiHints for: ${key}`).toHaveProperty(key);
      }
    });
  });
});
