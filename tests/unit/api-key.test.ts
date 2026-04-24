import { afterEach, describe, expect, it } from "vitest";

import { BAKED_API_KEY, resolveCortexApiKey } from "../../src/internal/api-key.js";

describe("resolveCortexApiKey", () => {
  const originalEnv = process.env.CORTEX_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CORTEX_API_KEY;
    } else {
      process.env.CORTEX_API_KEY = originalEnv;
    }
  });

  it("keeps existing API key precedence", () => {
    process.env.CORTEX_API_KEY = "env-key";

    expect(resolveCortexApiKey("config-key")).toBe("config-key");
    expect(resolveCortexApiKey()).toBe("env-key");

    delete process.env.CORTEX_API_KEY;
    expect(resolveCortexApiKey()).toBe(
      BAKED_API_KEY !== "__OPENCLAW_API_KEY__" ? BAKED_API_KEY : "",
    );
  });
});
