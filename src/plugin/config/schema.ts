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
  baseUrl: httpsUrl.default(
    "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
  ),
  userId: z.string().min(1).optional(),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  recallLimit: z.number().int().min(1).max(50).default(10),
  recallTopK: z.number().int().min(1).max(50).default(15),
  recallQueryType: z.enum(["factual", "emotional", "combined", "codex"]).default("combined"),
  recallTimeoutMs: z.number().int().min(100).max(120000).default(60000),
  toolTimeoutMs: z.number().int().min(1000).max(120000).default(60000),
  fileSync: z.boolean().default(true),
  transcriptSync: z.boolean().default(true),
  captureMaxPayloadBytes: z.number().int().min(1024).max(1_048_576).default(262_144),
  captureFilter: z.boolean().default(true),
  auditLog: z.boolean().default(false),
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
