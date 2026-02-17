import { describe, it, expect } from "vitest";
import { CortexConfigSchema } from "../../src/core/config/schema.js";

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
});
