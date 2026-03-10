import type { QueryType } from "../cortex/client.js";

export type SearchMode = "all" | "decisions" | "preferences" | "facts" | "recent";
type SearchModeSelection = SearchMode | undefined;

export interface PreparedSearchQuery {
  query: string;
  effectiveQuery: string;
  mode: SearchMode;
  queryType: QueryType;
  memoryType?: "decision" | "preference" | "fact";
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function coerceCliSearchQuery(input: string | string[] | undefined): string {
  if (Array.isArray(input)) return normalizeWhitespace(input.join(" "));
  if (typeof input === "string") return normalizeWhitespace(input);
  return "";
}

export function coerceSearchMode(input: string | undefined): SearchModeSelection {
  switch (input) {
    case "all":
    case "decisions":
    case "preferences":
    case "facts":
    case "recent":
      return input;
    default:
      return undefined;
  }
}

export function inferSearchMode(query: string): SearchMode {
  const normalized = normalizeWhitespace(query).toLowerCase();
  if (!normalized) return "all";

  const recentPatterns = [
    /\b(latest|recent|recently|newest|just now)\b/,
    /\bwhat(?:'s| is)? new\b/,
    /\bwhat happened (?:recently|last)\b/,
    /\bcurrent status\b/,
  ];
  if (recentPatterns.some((pattern) => pattern.test(normalized))) return "recent";

  const decisionPatterns = [
    /\b(decide|decision|decided|settled on|settle on|agreed on|choose|chose|chosen|picked|selected)\b/,
    /\bwhat (?:database|stack|framework|provider|approach|architecture|auth flow|auth|orm|queue)\b.*\b(?:use|used|choose|chose|chosen|picked|selected|settled)\b/,
    /\bwhy did we\b/,
    /\bwhat did we choose\b/,
  ];
  if (decisionPatterns.some((pattern) => pattern.test(normalized))) return "decisions";

  const preferencePatterns = [
    /\b(prefer|preference|favorite|favourite|likes?|dislikes?)\b/,
    /\bhow do i like\b/,
    /\bwhat .* preference\b/,
    /\bwhat .* (?:setting|settings|editor|theme|style)\b/,
  ];
  if (preferencePatterns.some((pattern) => pattern.test(normalized))) return "preferences";

  const factPatterns = [
    /^(who|what|when|where|which|how)\b/,
    /\b(database|postgres|mysql|redis|queue|api key|namespace|timeout|port|branch|package manager|orm)\b/,
    /\bdo we use\b/,
    /\bwhat is\b/,
  ];
  if (factPatterns.some((pattern) => pattern.test(normalized))) return "facts";

  return "all";
}

export function prepareSearchQuery(
  query: string,
  mode?: SearchModeSelection,
): PreparedSearchQuery {
  const normalizedQuery = normalizeWhitespace(query);
  const effectiveMode = mode ?? inferSearchMode(normalizedQuery);

  switch (effectiveMode) {
    case "decisions":
      return {
        query: normalizedQuery,
        effectiveQuery: `[type:decision] ${normalizedQuery}`,
        mode: effectiveMode,
        queryType: "factual",
        memoryType: "decision",
      };
    case "preferences":
      return {
        query: normalizedQuery,
        effectiveQuery: `[type:preference] ${normalizedQuery}`,
        mode: effectiveMode,
        queryType: "factual",
        memoryType: "preference",
      };
    case "facts":
      return {
        query: normalizedQuery,
        effectiveQuery: `[type:fact] ${normalizedQuery}`,
        mode: effectiveMode,
        queryType: "factual",
        memoryType: "fact",
      };
    case "recent":
      return {
        query: normalizedQuery,
        effectiveQuery: `most recent relevant memories about: ${normalizedQuery}`,
        mode: effectiveMode,
        queryType: "combined",
      };
    default:
      return {
        query: normalizedQuery,
        effectiveQuery: normalizedQuery,
        mode: effectiveMode,
        queryType: "combined",
      };
  }
}
