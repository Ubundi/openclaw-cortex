import { describe, expect, it, vi } from "vitest";
import {
  createClawDeployBridgeTraceClient,
  redactBridgeTraceError,
  resolveClawDeployBridgeTraceConfig,
} from "../../src/internal/clawdeploy-bridge-traces.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("ClawDeploy bridge trace client", () => {
  it("posts trace payloads to ClawDeploy with the gateway bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const logger = makeLogger();
    const client = createClawDeployBridgeTraceClient({
      baseUrl: "https://clawdeploy.example.com/",
      gatewayToken: "gateway-token-1",
      logger,
      fetchImpl,
    });

    client.emitBridgeTrace({
      requestId: "openclaw-bridge-123",
      sessionKey: "sess-1",
      cortexAgentUserId: "agent-user-1",
      targetSection: "coreValues",
      status: "detected",
      detectedAt: "2026-04-25T12:00:00.000Z",
      metadata: {
        source: "openclaw-cortex",
        authorization: "Bearer should-not-leak",
      },
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://clawdeploy.example.com/api/agent/tootoo/bridge-traces",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-token-1",
          "Content-Type": "application/json",
        }),
      }),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({
      requestId: "openclaw-bridge-123",
      sessionKey: "sess-1",
      cortexAgentUserId: "agent-user-1",
      targetSection: "coreValues",
      status: "detected",
    });
    expect(JSON.stringify(body)).not.toContain("should-not-leak");
  });

  it("skips trace emission cleanly when ClawDeploy URL or token is missing", () => {
    const fetchImpl = vi.fn();
    const logger = makeLogger();
    const client = createClawDeployBridgeTraceClient({
      baseUrl: "https://clawdeploy.example.com",
      gatewayToken: "",
      logger,
      fetchImpl,
    });

    expect(() => client.emitBridgeTrace({
      requestId: "openclaw-bridge-123",
      status: "detected",
    })).not.toThrow();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("skipped"));
  });

  it("does not throw when the trace endpoint fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "down" });
    const logger = makeLogger();
    const client = createClawDeployBridgeTraceClient({
      baseUrl: "https://clawdeploy.example.com",
      gatewayToken: "gateway-token-1",
      logger,
      fetchImpl,
    });

    expect(() => client.emitBridgeTrace({
      requestId: "openclaw-bridge-123",
      status: "accepted",
      forwarded: true,
      queuedForRetry: false,
      entriesSent: 1,
    })).not.toThrow();

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed: 503")));
  });

  it("resolves env/config values and honors the optional enable flag", () => {
    const config = resolveClawDeployBridgeTraceConfig(
      { clawDeployBaseUrl: "https://config.example.com", enableClawDeployBridgeTrace: false },
      {
        CLAWDEPLOY_BASE_URL: "https://env.example.com",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token-1",
      },
    );

    expect(config).toEqual({
      enabled: false,
      baseUrl: "https://config.example.com",
      gatewayToken: "gateway-token-1",
    });
  });
});

describe("redactBridgeTraceError", () => {
  it("redacts auth tokens, API keys, and private exchange content", () => {
    const redacted = redactBridgeTraceError(
      "Authorization: Bearer token-123 x-api-key=sk-secret answer=Autonomy and creative freedom.",
      ["Autonomy and creative freedom."],
    );

    expect(redacted).toContain("[REDACTED");
    expect(redacted).not.toContain("token-123");
    expect(redacted).not.toContain("sk-secret");
    expect(redacted).not.toContain("Autonomy and creative freedom");
  });
});
