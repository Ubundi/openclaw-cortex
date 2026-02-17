import { z } from "zod";

export const RecallMode = z.enum(["fast", "balanced", "full"]);
export type RecallMode = z.infer<typeof RecallMode>;

export const CortexConfigSchema = z.object({
  apiKey: z.string().min(1, "apiKey is required"),
  baseUrl: z
    .string()
    .url("baseUrl must be a valid URL")
    .default("https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod"),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  recallTopK: z.number().int().min(1).max(20).default(5),
  recallTimeoutMs: z.number().int().min(100).max(5000).default(500),
  recallMode: RecallMode.default("fast"),
  fileSync: z.boolean().default(true),
  transcriptSync: z.boolean().default(true),
  reflectIntervalMs: z.number().int().min(0).default(3_600_000),
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
