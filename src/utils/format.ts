import type { RetrieveResult } from "../client.js";

export function formatMemories(results: RetrieveResult[]): string {
  if (!results.length) return "";

  const lines = results.map(
    (r) => `- [${r.score.toFixed(2)}] ${r.content}`,
  );

  return `<cortex_memories>\n${lines.join("\n")}\n</cortex_memories>`;
}
