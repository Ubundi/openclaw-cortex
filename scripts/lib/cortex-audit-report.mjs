import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const API_KEY_RE = /\bsk_[A-Za-z0-9]{16,}\b/g;
const BEARER_TOKEN_RE = /(Authorization:\s*Bearer\s+)[^\s]+/gi;
const GENERIC_TOKEN_RE = /\b(?:ghp|github_pat|xox[pbar]-|AIza)[A-Za-z0-9_\-]{10,}\b/g;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatLabel(value) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function trimExcerpt(text, maxChars = 340) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function uniqueBySummary(signals) {
  const seen = new Set();
  return signals.filter((signal) => {
    if (seen.has(signal.summary)) return false;
    seen.add(signal.summary);
    return true;
  });
}

export function parseAuditIndex(rawIndex) {
  return rawIndex
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line);
      return {
        ts: parsed.ts,
        feature: parsed.feature,
        method: parsed.method ?? "POST",
        endpoint: parsed.endpoint,
        bytes: parsed.bytes ?? 0,
        payloadFile: parsed.payloadFile,
        sessionId: parsed.sessionId,
        userId: parsed.userId,
        messageCount: parsed.msgs,
      };
    });
}

export function redactSecrets(input) {
  return input
    .replace(API_KEY_RE, "[REDACTED_API_KEY]")
    .replace(BEARER_TOKEN_RE, "$1[REDACTED_TOKEN]")
    .replace(GENERIC_TOKEN_RE, "[REDACTED_TOKEN]");
}

function extractBulletList(text) {
  const matches = [...text.matchAll(/^\s*-\s+(.+)$/gm)];
  return matches.map((match) => match[1].trim()).filter(Boolean);
}

function extractValueSignalsFromPayload(entry, payload) {
  const signals = [];
  const redactedPayload = redactSecrets(payload);

  if (/KD\s*&\s*GM group/i.test(payload) && /using most regularly/i.test(payload)) {
    signals.push({
      kind: "default",
      summary: "KD & GM is the user's default Splitsmarter group.",
      whyItMatters: "The agent can default to the right group later instead of asking the user to restate it each time.",
      ts: entry.ts,
      feature: entry.feature,
      source: trimExcerpt(redactedPayload),
    });
  }

  if (/when I ask you to add an expense, update an expense, or manage an expense/i.test(payload)) {
    const bullets = extractBulletList(payload);
    const required = bullets
      .filter((item) => /description|date|currency|split type|amount|who paid/i.test(item))
      .map((item) => item.replace(/^an?\s+/i, ""));

    if (required.length > 0) {
      signals.push({
        kind: "workflow-rule",
        summary: "Expense management requests must include description, date, currency, split type, amount, and who paid.",
        whyItMatters: "Cortex preserves the user's operating rules so the agent can gather the right fields before acting in future sessions.",
        ts: entry.ts,
        feature: entry.feature,
        source: trimExcerpt(redactSecrets(required.join(", ")), 220),
      });
    }
  }

  if (/I won[’']t store it in memory/i.test(payload)) {
    signals.push({
      kind: "security-rule",
      summary: "The agent explicitly treated the API key as sensitive and not suitable for memory.",
      whyItMatters: "This shows useful filtering: Cortex can preserve durable workflow information without presenting secrets as reusable memory.",
      ts: entry.ts,
      feature: entry.feature,
      source: trimExcerpt(redactedPayload),
    });
  }

  if (/save your Splitsmarter preferences\/default-group note/i.test(payload)) {
    signals.push({
      kind: "intent",
      summary: "The agent recognized the user's Splitsmarter defaults as worth preserving for future use.",
      whyItMatters: "This is the bridge from raw conversation to durable memory: the agent identified reusable context, not just task-local chatter.",
      ts: entry.ts,
      feature: entry.feature,
      source: trimExcerpt(redactedPayload),
    });
  }

  return signals;
}

export function collectValueSignals(entries, payloads) {
  const signals = [];
  for (const entry of entries) {
    if (entry.feature !== "auto-capture") continue;
    const payload = payloads.get(entry.payloadFile);
    if (!payload) continue;
    signals.push(...extractValueSignalsFromPayload(entry, payload));
  }
  return uniqueBySummary(signals);
}

function countByFeature(entries) {
  return entries.reduce((acc, entry) => {
    acc[entry.feature] = (acc[entry.feature] ?? 0) + 1;
    return acc;
  }, {});
}

function summarizeTimeline(entries) {
  return entries.map((entry) => ({
    ...entry,
    label: formatLabel(entry.feature),
  }));
}

function collectEvidence(entries, payloads, limit = 8) {
  return entries
    .filter((entry) => entry.feature === "auto-capture" || entry.feature === "tool-search-memory")
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      excerpt: trimExcerpt(redactSecrets(payloads.get(entry.payloadFile) ?? ""), 500),
    }))
    .filter((item) => item.excerpt.length > 0);
}

function buildRecallExample(signals) {
  const defaultGroup = signals.find((signal) => signal.summary.includes("default Splitsmarter group"));
  const workflowRule = signals.find((signal) => signal.summary.includes("Expense management requests must include"));

  if (!defaultGroup && !workflowRule) return null;

  const answerBits = [];
  if (defaultGroup) {
    answerBits.push("use the remembered KD & GM group as the default");
  }
  if (workflowRule) {
    answerBits.push("check that description, date, currency, split type, amount, and who paid are all present before acting");
  }

  return {
    prompt: "If the user returns later and says “add a dinner expense for us,” the agent would not need to start from zero.",
    response: `Cortex gives the agent enough saved context to ${answerBits.join(" and ")}.`,
  };
}

export function renderHtmlReport(report) {
  const recallExample = buildRecallExample(report.signals);
  const metricCards = [
    ["Captured Turns", report.metrics["auto-capture"] ?? 0],
    ["Recall Calls", report.metrics["auto-recall"] ?? 0],
    ["Fallback Recalls", report.metrics["auto-recall-fallback"] ?? 0],
    ["Memory Searches", report.metrics["tool-search-memory"] ?? 0],
  ].map(([label, value]) => `
    <div class="metric">
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <div class="metric-label">${escapeHtml(label)}</div>
    </div>
  `).join("");

  const signals = report.signals.map((signal) => `
    <article class="signal">
      <p class="eyebrow">${escapeHtml(formatLabel(signal.kind))}</p>
      <h3>${escapeHtml(signal.summary)}</h3>
      <p>${escapeHtml(signal.whyItMatters)}</p>
      <blockquote>${escapeHtml(signal.source)}</blockquote>
    </article>
  `).join("");

  const evidence = report.evidence.map((item) => `
    <article class="evidence-item">
      <div class="evidence-meta">
        <span>${escapeHtml(item.label)}</span>
        <span>${escapeHtml(item.ts)}</span>
      </div>
      <pre>${escapeHtml(item.excerpt)}</pre>
    </article>
  `).join("");

  const timeline = report.timeline.map((item) => `
    <div class="timeline-row">
      <div class="timeline-time">${escapeHtml(item.ts)}</div>
      <div class="timeline-event">
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(item.endpoint)}</span>
      </div>
    </div>
  `).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cortex Value Report</title>
  <style>
    :root {
      --bg: #f3efe7;
      --paper: rgba(255,255,255,0.72);
      --ink: #1f1e1a;
      --muted: #666255;
      --accent: #17624f;
      --accent-soft: #d8efe7;
      --line: rgba(31,30,26,0.12);
      --shadow: 0 20px 70px rgba(34, 30, 20, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Instrument Sans", "Inter", system-ui, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(23,98,79,0.16), transparent 32%),
        radial-gradient(circle at top right, rgba(183,116,54,0.13), transparent 28%),
        linear-gradient(180deg, #f7f3ea 0%, var(--bg) 100%);
    }
    .shell {
      width: min(1180px, calc(100vw - 32px));
      margin: 24px auto 56px;
    }
    .hero, .section {
      background: var(--paper);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.55);
      box-shadow: var(--shadow);
      border-radius: 28px;
    }
    .hero {
      padding: 40px;
      overflow: hidden;
      position: relative;
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -80px -120px auto;
      width: 280px;
      height: 280px;
      background: radial-gradient(circle, rgba(23,98,79,0.18), transparent 70%);
      pointer-events: none;
    }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-size: 12px;
      color: var(--accent);
      margin: 0 0 12px;
    }
    h1 {
      font-family: "Fraunces", Georgia, serif;
      font-size: clamp(2.5rem, 6vw, 5rem);
      line-height: 0.95;
      margin: 0;
      max-width: 9ch;
    }
    .hero-copy {
      max-width: 760px;
      font-size: 1.05rem;
      line-height: 1.7;
      color: var(--muted);
      margin-top: 20px;
    }
    .hero-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-top: 28px;
    }
    .hero-meta div {
      padding: 14px 16px;
      background: rgba(255,255,255,0.56);
      border-radius: 16px;
      border: 1px solid var(--line);
    }
    .hero-meta span {
      display: block;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .grid {
      display: grid;
      gap: 20px;
      margin-top: 20px;
    }
    .metrics {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    .metric {
      padding: 24px;
      border-radius: 22px;
      background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(244,240,232,0.86));
      border: 1px solid var(--line);
    }
    .metric-value {
      font-family: "Fraunces", Georgia, serif;
      font-size: 3rem;
      line-height: 1;
      margin-bottom: 6px;
    }
    .metric-label {
      color: var(--muted);
    }
    .section {
      margin-top: 20px;
      padding: 28px;
    }
    .section h2 {
      font-family: "Fraunces", Georgia, serif;
      font-size: 2rem;
      margin: 0 0 10px;
    }
    .section-intro {
      color: var(--muted);
      line-height: 1.7;
      max-width: 76ch;
      margin-bottom: 24px;
    }
    .signals {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .signal, .evidence-item {
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 22px;
      background: rgba(255,255,255,0.72);
    }
    .signal h3 {
      margin: 0 0 12px;
      font-size: 1.2rem;
    }
    .signal p {
      margin: 0 0 14px;
      line-height: 1.7;
      color: var(--muted);
    }
    blockquote, pre {
      margin: 0;
      padding: 16px;
      border-radius: 16px;
      background: #f7f4ec;
      border: 1px solid rgba(31,30,26,0.08);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
      font-size: 0.88rem;
      line-height: 1.6;
      color: #2c2a24;
    }
    .timeline-row {
      display: grid;
      grid-template-columns: 220px 1fr;
      gap: 20px;
      padding: 14px 0;
      border-top: 1px solid var(--line);
    }
    .timeline-row:first-child { border-top: 0; }
    .timeline-time {
      color: var(--muted);
      font-size: 0.92rem;
    }
    .timeline-event {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .timeline-event span { color: var(--muted); }
    .evidence-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
      color: var(--muted);
      font-size: 0.88rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    @media (max-width: 720px) {
      .shell { width: min(100vw - 20px, 1180px); margin: 10px auto 28px; }
      .hero, .section { padding: 20px; border-radius: 22px; }
      .timeline-row { grid-template-columns: 1fr; gap: 8px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Cortex Value Report</p>
      <h1>What Cortex captured, and why it helps later.</h1>
      <p class="hero-copy">
        This report is built from a real OpenClaw Cortex audit bundle. It shows the exact useful information Cortex captured during the session, how memory stayed active across the interaction, and why those saved details make future agent responses faster, more consistent, and less repetitive for the user.
      </p>
      <div class="hero-meta">
        <div><span>Instance</span>${escapeHtml(report.instanceLabel)}</div>
        <div><span>User ID</span>${escapeHtml(report.userId)}</div>
        <div><span>Session ID</span>${escapeHtml(report.sessionId ?? "Unknown")}</div>
        <div><span>Event Window</span>${escapeHtml(report.timeRange)}</div>
      </div>
      <div class="grid metrics">${metricCards}</div>
    </section>

    <section class="section">
      <p class="eyebrow">Value Story</p>
      <h2>What Cortex learned that is worth keeping</h2>
      <p class="section-intro">
        These items come directly from the captured session payloads. They are not generic summaries. They are the specific defaults, instructions, and operating rules that become valuable later because the user should not have to repeat them and the agent should not have to rediscover them.
      </p>
      <div class="grid signals">${signals}</div>
    </section>

    <section class="section">
      <p class="eyebrow">Future Recall</p>
      <h2>How that memory pays off later</h2>
      <p class="section-intro">
        The captured information below changes future behavior in practical ways. It preserves defaults, enforces the user's preferred workflow, and lets the agent continue from prior context instead of forcing the user to re-explain stable details.
      </p>
      ${recallExample ? `
      <article class="signal" style="margin-bottom: 20px;">
        <p class="eyebrow">Future Recall Example</p>
        <h3>If the user returns later</h3>
        <p>${escapeHtml(recallExample.prompt)}</p>
        <blockquote>${escapeHtml(recallExample.response)}</blockquote>
      </article>
      ` : ""}
      <div class="grid signals">
        <article class="signal">
          <h3>Less repetition for the user</h3>
          <p>The user established a default Splitsmarter group and a stable set of required expense fields. Cortex turns that into reusable memory, so the next session can start from context instead of clarification.</p>
        </article>
        <article class="signal">
          <h3>Better guardrails for the agent</h3>
          <p>Cortex preserves behavioral rules, not only facts. In this session, the user specified what must be collected before expense actions happen, which gives future turns a reliable operating checklist instead of guesswork.</p>
        </article>
        <article class="signal">
          <h3>Selective memory, not indiscriminate storage</h3>
          <p>The conversation includes a live API key, but the agent also explicitly states that it should not be stored in memory. That shows the right boundary: Cortex is valuable because it keeps durable context, not because it hoards sensitive data.</p>
        </article>
      </div>
    </section>

    <section class="section">
      <p class="eyebrow">Activity</p>
      <h2>How Cortex stayed involved across the session</h2>
      <div>${timeline}</div>
    </section>

    <section class="section">
      <p class="eyebrow">Evidence</p>
      <h2>Real captured evidence</h2>
      <p class="section-intro">
        These excerpts come from the recovered audit payloads. Secrets have been redacted automatically, but the surrounding content is preserved so the report stays grounded in the actual session rather than in reconstructed examples.
      </p>
      <div class="grid signals">${evidence}</div>
    </section>
  </main>
</body>
</html>`;
}

export async function loadAuditBundle(bundleDir, userIdPath) {
  const indexPath = join(bundleDir, "extracted", "audit", "index.jsonl");
  const payloadDir = join(bundleDir, "extracted", "audit", "payloads");
  const rawIndex = await readFile(indexPath, "utf8");
  const userId = (await readFile(userIdPath, "utf8")).trim();
  const entries = parseAuditIndex(rawIndex);

  const payloads = new Map();
  for (const entry of entries) {
    if (payloads.has(entry.payloadFile)) continue;
    const payloadPath = join(payloadDir, entry.payloadFile);
    const payload = await readFile(payloadPath, "utf8");
    payloads.set(entry.payloadFile, payload);
  }

  return { entries, payloads, userId };
}

export async function buildReport(bundleDir, userIdPath) {
  const { entries, payloads, userId } = await loadAuditBundle(bundleDir, userIdPath);
  const metrics = countByFeature(entries);
  const signals = collectValueSignals(entries, payloads);
  const evidence = collectEvidence(entries, payloads);
  const timeline = summarizeTimeline(entries);
  const sessionId = entries.find((entry) => entry.sessionId)?.sessionId;
  const firstTs = entries[0]?.ts;
  const lastTs = entries.at(-1)?.ts;

  return {
    instanceLabel: basename(bundleDir),
    userId,
    sessionId,
    metrics,
    signals,
    evidence,
    timeline,
    timeRange: firstTs && lastTs ? `${firstTs} to ${lastTs}` : "Unknown",
  };
}

export async function writeHtmlReport(bundleDir, userIdPath, outputPath) {
  const report = await buildReport(bundleDir, userIdPath);
  const html = renderHtmlReport(report);
  await writeFile(outputPath, html, "utf8");
  return report;
}
