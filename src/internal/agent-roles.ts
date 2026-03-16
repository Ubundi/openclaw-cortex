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
