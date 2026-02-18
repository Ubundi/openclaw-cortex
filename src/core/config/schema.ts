import { z } from "zod";

export const RecallMode = z.enum(["fast", "balanced", "full"]);
export type RecallMode = z.infer<typeof RecallMode>;

export const RecallQueryType = z.enum(["factual", "emotional", "combined"]);
export type RecallQueryType = z.infer<typeof RecallQueryType>;

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
  apiKey: z.string().min(1, "apiKey is required"),
  baseUrl: httpsUrl.default(
    "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
  ),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  recallTopK: z.number().int().min(1).max(20).default(5),
  recallTimeoutMs: z.number().int().min(100).max(10000).default(500),
  recallMode: RecallMode.default("fast"),
  recallQueryType: RecallQueryType.default("combined"),
  fileSync: z.boolean().default(true),
  transcriptSync: z.boolean().default(true),
  reflectIntervalMs: z.number().int().min(0).default(3_600_000),
  namespace: z.string().min(1).default("openclaw"),
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
