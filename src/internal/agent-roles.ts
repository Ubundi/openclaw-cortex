export type AgentRole = "developer" | "researcher" | "manager" | "support" | "generalist";

export interface RolePreset {
  captureCategories: string[];
  captureInstructions: string;
  recallContext: string;
}

const PRESETS: Record<AgentRole, RolePreset> = {
  developer: {
    captureCategories: [
      "Architecture decisions and trade-offs",
      "Library and framework choices",
      "API design patterns",
      "Deployment and infrastructure config",
      "Bug root causes and fixes",
      "Code conventions and style preferences",
    ],
    captureInstructions:
      "Focus on technical decisions with rationale, library/framework choices, architecture patterns, deployment configurations, and debugging insights. Skip routine code edits and command outputs.",
    recallContext: "software engineering, technical decisions, code architecture",
  },
  researcher: {
    captureCategories: [
      "Research findings and data points",
      "Hypotheses and assumptions",
      "Methodology decisions",
      "Source evaluations and references",
      "Comparisons and trade-off analyses",
      "Conclusions and recommendations",
    ],
    captureInstructions:
      "Focus on research findings, data sources, methodology decisions, comparative analyses, and conclusions. Capture hypotheses and the evidence that supports or refutes them.",
    recallContext: "research findings, analysis, methodology, evidence",
  },
  manager: {
    captureCategories: [
      "Project status and milestones",
      "Team assignments and responsibilities",
      "Deadlines and timelines",
      "Stakeholder feedback and requests",
      "Priority decisions and escalations",
      "Resource constraints and blockers",
    ],
    captureInstructions:
      "Focus on project status, team assignments, deadlines, stakeholder decisions, and priority changes. Capture who is responsible for what and when things are due.",
    recallContext: "project status, team coordination, deadlines, priorities",
  },
  support: {
    captureCategories: [
      "Customer issues and resolutions",
      "Troubleshooting steps and outcomes",
      "Known issues and workarounds",
      "Escalation paths and contacts",
      "SLA and response time patterns",
      "Configuration fixes",
    ],
    captureInstructions:
      "Focus on customer issues, resolution steps, known workarounds, and escalation patterns. Capture what fixed the problem and how to reproduce it.",
    recallContext: "customer issues, troubleshooting, resolutions, known problems",
  },
  generalist: {
    captureCategories: [],
    captureInstructions: "",
    recallContext: "",
  },
};

export function getRolePreset(role: AgentRole): RolePreset {
  return PRESETS[role];
}

// --- Auto-detection from bootstrap files ---

const BOOTSTRAP_FILES = ["SOUL.md", "AGENTS.md", "USER.md", "IDENTITY.md"];

interface RoleSignals {
  developer: RegExp[];
  researcher: RegExp[];
  manager: RegExp[];
  support: RegExp[];
}

const ROLE_SIGNALS: RoleSignals = {
  developer: [
    /\b(engineer|developer|programmer|coder|software|coding|programming)\b/i,
    /\b(code|deploy|debug|architecture|infrastructure|api|backend|frontend|fullstack)\b/i,
    /\b(typescript|javascript|python|rust|go|react|node|docker|kubernetes|ci\/cd)\b/i,
    /\b(repository|repo|git|branch|merge|pull request|commit)\b/i,
    /\b(build|compile|lint|test suite|unit test|integration test)\b/i,
  ],
  researcher: [
    /\b(research|researcher|analyst|investigat|study|academic|scientist)\b/i,
    /\b(hypothesis|methodology|findings|evidence|data|analysis|literature)\b/i,
    /\b(compare|evaluate|assess|synthesize|review|survey|benchmark)\b/i,
    /\b(paper|journal|citation|source|reference|publication)\b/i,
  ],
  manager: [
    /\b(manager|coordinator|lead|director|head of|team lead|project manager|scrum)\b/i,
    /\b(project|milestone|deadline|timeline|roadmap|sprint|backlog)\b/i,
    /\b(stakeholder|status update|standup|retro|planning|prioriti[sz])\b/i,
    /\b(assign|delegate|resource|capacity|budget|schedule)\b/i,
  ],
  support: [
    /\b(support|helpdesk|help desk|customer service|customer success)\b/i,
    /\b(ticket|incident|escalat|triage|sla|response time)\b/i,
    /\b(troubleshoot|diagnos|workaround|known issue|resolution)\b/i,
    /\b(customer|client|user complaint|user issue|bug report)\b/i,
  ],
};

function scoreText(text: string, signals: RegExp[]): number {
  let hits = 0;
  for (const pattern of signals) {
    if (pattern.test(text)) hits++;
  }
  return hits;
}

/**
 * Detects the agent's role by scanning bootstrap files for role-indicating
 * keywords. Reads SOUL.md, AGENTS.md, USER.md, and IDENTITY.md in order,
 * concatenates their content, and scores against role signal patterns.
 *
 * Returns the highest-scoring role, or undefined if no role scores above
 * the minimum threshold (meaning the content is too generic to classify).
 */
export async function detectAgentRole(
  workspaceDir: string,
  agentDir?: string,
): Promise<AgentRole | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const texts: string[] = [];

  // Check both workspace and agent-specific directories
  const dirs = agentDir ? [agentDir, workspaceDir] : [workspaceDir];

  for (const dir of dirs) {
    for (const filename of BOOTSTRAP_FILES) {
      try {
        const content = await readFile(join(dir, filename), "utf-8");
        if (content.trim()) texts.push(content);
      } catch {
        // File doesn't exist — skip
      }
    }
  }

  if (texts.length === 0) return undefined;

  const combined = texts.join("\n");
  const MIN_SCORE = 2; // need at least 2 signal hits to classify

  const scores: [AgentRole, number][] = [
    ["developer", scoreText(combined, ROLE_SIGNALS.developer)],
    ["researcher", scoreText(combined, ROLE_SIGNALS.researcher)],
    ["manager", scoreText(combined, ROLE_SIGNALS.manager)],
    ["support", scoreText(combined, ROLE_SIGNALS.support)],
  ];

  scores.sort((a, b) => b[1] - a[1]);

  const [topRole, topScore] = scores[0];
  if (topScore < MIN_SCORE) return undefined;

  // Require clear winner — if top two are within 1 point, too ambiguous
  const [, secondScore] = scores[1];
  if (topScore - secondScore <= 1) return undefined;

  return topRole;
}
