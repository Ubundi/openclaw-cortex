/**
 * The Cortex API key is injected at publish time by scripts/inject-api-key.mjs.
 * In source this is a placeholder; the dist file contains the real value.
 * Never commit a real key here.
 */
export const BAKED_API_KEY = "__OPENCLAW_API_KEY__";

export function resolveCortexApiKey(configApiKey?: string): string {
  return (
    configApiKey ||
    process.env.CORTEX_API_KEY ||
    (BAKED_API_KEY !== "__OPENCLAW_API_KEY__" && BAKED_API_KEY) ||
    ""
  );
}
