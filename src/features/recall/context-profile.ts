import type { CortexConfig } from "../../plugin/config.js";

export type RecallProfile = "default" | "factual" | "planning" | "incident" | "handoff";

export interface RecallProfileParams {
  queryType: "factual" | "emotional" | "combined" | "codex";
  limit: number;
  context?: string;
  minConfidence?: number;
}

const INCIDENT_RE = /\b(outage|incident|sev[1-4]|broken|failure|urgent|rollback|hotfix|degraded|bug|crash|error)\b/i;
const HANDOFF_RE = /\b(resume|continue|handoff|pick up|where (did|was) i|last session|what was i)\b/i;
const PLANNING_RE = /\b(plan|planning|design|architecture|roadmap|proposal|spec|migrate|migration|approach|strategy)\b/i;
const FACTUAL_RE = /\b(what (is|was|are|were)|which|how (many|much)|port|version|config|setting|ttl|timeout|url|endpoint)\b/i;

export function inferRecallProfile(prompt: string): RecallProfile {
  if (INCIDENT_RE.test(prompt)) return "incident";
  if (HANDOFF_RE.test(prompt)) return "handoff";
  if (PLANNING_RE.test(prompt)) return "planning";
  if (FACTUAL_RE.test(prompt)) return "factual";
  return "default";
}

export function getProfileParams(
  profile: RecallProfile,
  config: CortexConfig,
  factualContext?: string,
): RecallProfileParams {
  switch (profile) {
    case "incident":
      return {
        queryType: "factual",
        limit: Math.min(config.recallLimit * 2, 50),
        minConfidence: 0.3,
      };
    case "handoff":
      return {
        queryType: "combined",
        limit: config.recallLimit,
        context: "session handoff, recent work, current tasks",
      };
    case "planning":
      return {
        queryType: "combined",
        limit: Math.min(Math.ceil(config.recallLimit * 1.5), 50),
        context: "architecture, design decisions, technical strategy",
      };
    case "factual":
      return {
        queryType: "factual",
        limit: config.recallLimit,
        minConfidence: 0.3,
        context: factualContext,
      };
    case "default":
      return {
        queryType: config.recallQueryType,
        limit: config.recallLimit,
      };
  }
}
