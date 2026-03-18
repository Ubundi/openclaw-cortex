import { z } from "zod";

/**
 * Validates that a URL uses HTTPS, with an exception for localhost in development.
 */
const httpsUrl = z
  .string()
  .url("baseUrl must be a valid URL")
  .refine(
    (url) => {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") return true;
      // Allow http only for localhost/127.0.0.1 (development)
      if (
        parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
      ) {
        return true;
      }
      return false;
    },
    { message: "baseUrl must use HTTPS (http allowed only for localhost)" },
  );

export const CortexConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  baseUrl: httpsUrl.default(
    "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
  ),
  userId: z.string().min(1).optional(),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  recallLimit: z.number().int().min(1).max(50).default(20),
  recallTopK: z.number().int().min(1).max(50).default(10),
  recallQueryType: z.enum(["factual", "emotional", "combined", "codex"]).default("combined"),
  recallProfile: z.enum(["auto", "default", "factual", "planning", "incident", "handoff"]).default("auto"),
  recallTimeoutMs: z.number().int().min(100).max(120000).default(60000),
  toolTimeoutMs: z.number().int().min(1000).max(120000).default(60000),
  captureMaxPayloadBytes: z.number().int().min(1024).max(1_048_576).default(262_144),
  captureFilter: z.boolean().default(true),
  dedupeWindowMinutes: z.number().int().min(0).max(1440).default(30),
  noveltyThreshold: z.number().min(0).max(1).default(0.85),
  auditLog: z.boolean().default(true),
  namespace: z.string().min(1).default("openclaw"),
  captureInstructions: z.string().max(2000).optional(),
  captureCategories: z.array(z.string().min(1).max(100)).max(20).optional(),
  sessionGoal: z.boolean().default(true),
  agentRole: z.enum(["developer", "researcher", "manager", "support", "generalist"]).optional(),
  /**
   * Optional fixed reference date (ISO 8601) to use as the temporal anchor for
   * all recall queries instead of `new Date()`. Useful when replaying historical
   * data in benchmarks — set this to the day *after* the last session in the
   * dataset so the temporal channel sees the correct recency ordering.
   *
   * Example: "2024-11-18" for the Arclight V2 benchmark dataset.
   *
   * Leave unset in production; the plugin will use the real current time.
   */
  recallReferenceDate: z.string().min(1).optional(),
});

export type CortexConfig = z.infer<typeof CortexConfigSchema>;

/**
 * Config schema compatible with OpenClaw's pluginConfigSchema interface.
 * OpenClaw calls safeParse() during plugin registration.
 */
export const configSchema = {
  safeParse(value: unknown) {
    return CortexConfigSchema.safeParse(value);
  },
};
