/**
 * Content-aware compression for large messages before Cortex ingestion.
 * Replaces blind truncation with structured summaries that preserve
 * key facts for the backend's fact extraction pipeline.
 */

export type ContentFormat = "json" | "yaml" | "code" | "logs" | "config" | "text";

const SUMMARY_BUDGET = 2_000;

// --- Format detection ---

const JSON_START_RE = /^\s*[{\[]/;
const YAML_HEADER_RE = /^---\s*$/m;
const YAML_KV_RE = /^\w[\w.-]*\s*:/m;
const LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const CODE_IMPORT_RE = /^(import |from |require\(|const .+ = require|#include |using |package )/m;
const CODE_DEF_RE = /^(function |def |class |export |pub fn |fn |async function |const \w+ = (?:async )?\()/m;
// Config directives that are NOT ambiguous with YAML
const CONFIG_DIRECTIVE_RE = /^\s*(server\s*\{|location\s|upstream\s|FROM |RUN |ENV |COPY |ADD |ENTRYPOINT |CMD )/m;

export function detectContentFormat(content: string): ContentFormat {
  const head = content.slice(0, 500);
  const lines = content.split("\n");

  // JSON: starts with { or [ and is parseable (or at least looks like JSON)
  if (JSON_START_RE.test(head)) {
    try {
      JSON.parse(content);
      return "json";
    } catch {
      // Truncated JSON — still treat as JSON if it has nested structure
      if (/["{}[\]:,]/.test(head.slice(0, 100))) return "json";
    }
  }

  // Logs: multiple lines starting with timestamps — check early
  const logLineCount = lines.slice(0, 20).filter((l) => LOG_LINE_RE.test(l)).length;
  if (logLineCount >= 3) return "logs";

  // YAML — check before config since docker-compose is YAML
  if (YAML_HEADER_RE.test(head) || (YAML_KV_RE.test(head) && head.includes("\n"))) {
    const kvCount = lines.slice(0, 30).filter((l) => /^\w[\w.-]*\s*:/.test(l)).length;
    if (kvCount >= 2) return "yaml";
  }

  // Config (nginx, Dockerfile) — unambiguous directives only
  if (CONFIG_DIRECTIVE_RE.test(head)) return "config";

  // Code
  if (CODE_IMPORT_RE.test(head) || CODE_DEF_RE.test(head)) return "code";

  return "text";
}

// --- Per-format summarizers ---

export function summarizeJson(content: string): string {
  const lines: string[] = [];
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      lines.push(`Top-level keys: ${keys.join(", ")} (${keys.length} keys)`);
      for (const key of keys.slice(0, 10)) {
        const val = parsed[key];
        if (typeof val === "object" && val !== null) {
          if (Array.isArray(val)) {
            lines.push(`  ${key}: array (${val.length} items)`);
          } else {
            const subKeys = Object.keys(val);
            const preview = subKeys.slice(0, 5).join(", ");
            const more = subKeys.length > 5 ? `, +${subKeys.length - 5} more` : "";
            lines.push(`  ${key}: {${preview}${more}}`);
          }
        } else {
          lines.push(`  ${key}: ${JSON.stringify(val)}`);
        }
      }
      if (keys.length > 10) lines.push(`  ... +${keys.length - 10} more keys`);
    } else if (Array.isArray(parsed)) {
      lines.push(`Array with ${parsed.length} items`);
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        lines.push(`Item keys: ${Object.keys(parsed[0]).join(", ")}`);
      }
    }
  } catch {
    // Malformed JSON — extract what we can with regex
    const keyMatches = content.match(/"(\w[\w.-]*)"\s*:/g);
    if (keyMatches) {
      const uniqueKeys = [...new Set(keyMatches.map((m) => m.replace(/[":\s]/g, "")))];
      lines.push(`Detected keys (partial parse): ${uniqueKeys.slice(0, 20).join(", ")}`);
    }
  }
  return lines.join("\n").slice(0, SUMMARY_BUDGET);
}

export function summarizeYaml(content: string): string {
  const lines: string[] = [];
  const yamlLines = content.split("\n");
  const topLevelKeys: string[] = [];
  for (const line of yamlLines) {
    const match = line.match(/^(\w[\w.-]*)\s*:/);
    if (match) topLevelKeys.push(match[1]);
  }
  if (topLevelKeys.length > 0) {
    lines.push(`Top-level keys: ${topLevelKeys.slice(0, 20).join(", ")} (${topLevelKeys.length} keys)`);
  }
  return lines.join("\n").slice(0, SUMMARY_BUDGET);
}

export function summarizeLogs(content: string): string {
  const logLines = content.split("\n").filter((l) => l.trim().length > 0);
  const lines: string[] = [];

  // Time range
  const timestamps: string[] = [];
  for (const line of logLines) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)/);
    if (match) timestamps.push(match[1]);
  }
  if (timestamps.length >= 2) {
    lines.push(`Time range: ${timestamps[0]} to ${timestamps[timestamps.length - 1]}`);
  }

  // Log level counts
  const levelCounts: Record<string, number> = {};
  const LEVEL_RE = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRIT(?:ICAL)?)\b/i;
  for (const line of logLines) {
    const match = line.match(LEVEL_RE);
    if (match) {
      const level = match[1].toUpperCase().replace("WARNING", "WARN").replace("CRITICAL", "CRIT");
      levelCounts[level] = (levelCounts[level] ?? 0) + 1;
    }
  }
  if (Object.keys(levelCounts).length > 0) {
    const breakdown = Object.entries(levelCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([level, count]) => `${level}=${count}`)
      .join(", ");
    lines.push(`Log levels: ${breakdown}`);
  }

  // Error summary — deduplicate and count
  const errorLines = logLines.filter((l) => /\b(ERROR|FATAL|CRIT)/i.test(l));
  if (errorLines.length > 0) {
    const errorMessages: Map<string, { count: number; first: string }> = new Map();
    for (const line of errorLines) {
      // Strip timestamp and level prefix to get the core message
      const core = line.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\s]*\s+\S+\s+/, "").trim();
      const normalized = core.slice(0, 100);
      const existing = errorMessages.get(normalized);
      if (existing) {
        existing.count++;
      } else {
        const ts = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\s]*)/);
        errorMessages.set(normalized, { count: 1, first: ts?.[1] ?? "" });
      }
    }
    lines.push("Error summary:");
    const sorted = [...errorMessages.entries()].sort(([, a], [, b]) => b.count - a.count);
    for (const [msg, info] of sorted.slice(0, 10)) {
      const countStr = info.count > 1 ? ` (x${info.count})` : "";
      const tsStr = info.first ? `, first at ${info.first}` : "";
      lines.push(`  - "${msg}"${countStr}${tsStr}`);
    }
  }

  return lines.join("\n").slice(0, SUMMARY_BUDGET);
}

export function summarizeCode(content: string): string {
  const codeLines = content.split("\n");
  const lines: string[] = [];

  // Detect language from patterns
  const hasImport = /^import\s/m.test(content);
  const hasDef = /^def\s/m.test(content);
  const hasClass = /^class\s/m.test(content);
  const hasFrom = /^from\s/m.test(content);
  const hasConst = /^(export\s+)?(const|let|var)\s/m.test(content);
  const hasFunction = /^(export\s+)?(async\s+)?function\s/m.test(content);
  const hasFn = /^(pub\s+)?fn\s/m.test(content);

  let lang = "unknown";
  if ((hasImport && hasFrom && hasDef) || (hasDef && hasClass)) lang = "Python";
  else if (hasConst || hasFunction) lang = "JavaScript/TypeScript";
  else if (hasFn) lang = "Rust";
  else if (/^package\s/m.test(content)) lang = "Go";
  if (lang !== "unknown") lines.push(`Language: ${lang}`);

  // Imports
  const imports: string[] = [];
  for (const line of codeLines) {
    // JS/TS import — check first since Python `import x` would also match
    const jsImport = line.match(/^import\s+.*?\s+from\s+["']([^"']+)["']/);
    if (jsImport) { imports.push(jsImport[1]); continue; }
    // Python import
    const pyImport = line.match(/^(?:from\s+(\S+)\s+import|import\s+([\w.]+))/);
    if (pyImport) { imports.push(pyImport[1] ?? pyImport[2]); continue; }
    const requireMatch = line.match(/require\(["']([^"']+)["']\)/);
    if (requireMatch) imports.push(requireMatch[1]);
  }
  if (imports.length > 0) {
    lines.push(`Imports: ${[...new Set(imports)].slice(0, 15).join(", ")}`);
  }

  // Classes and functions
  const classes: string[] = [];
  const functions: string[] = [];
  for (const line of codeLines) {
    const classMatch = line.match(/^(?:export\s+)?class\s+(\w+)/);
    if (classMatch) { classes.push(classMatch[1]); continue; }
    const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?(?:function\s+|def\s+|(?:pub\s+)?fn\s+)(\w+)/);
    if (funcMatch) functions.push(funcMatch[1]);
  }
  if (classes.length > 0) lines.push(`Classes: ${classes.slice(0, 10).join(", ")}`);
  if (functions.length > 0) lines.push(`Functions: ${functions.slice(0, 20).join(", ")}`);

  return lines.join("\n").slice(0, SUMMARY_BUDGET);
}

export function summarizeConfig(content: string): string {
  const lines: string[] = [];

  // Nginx
  const nginxBlocks = content.match(/(?:server|location|upstream)\s+[^{]*\{/g);
  if (nginxBlocks) {
    lines.push(`Nginx blocks: ${nginxBlocks.map((b) => b.replace(/\s*\{$/, "").trim()).slice(0, 10).join(", ")}`);
  }

  // Docker Compose
  const serviceMatch = content.match(/^services:\s*\n((?:\s+\w[\w-]*:\s*\n[\s\S]*?(?=\n\w|\n$))*)/m);
  if (serviceMatch) {
    const serviceNames = serviceMatch[1].match(/^\s{2}(\w[\w-]*):/gm);
    if (serviceNames) {
      lines.push(`Services: ${serviceNames.map((s) => s.trim().replace(/:$/, "")).join(", ")}`);
    }
  }

  // Dockerfile
  const fromImages = content.match(/^FROM\s+(\S+)/gm);
  if (fromImages) {
    lines.push(`Base images: ${fromImages.map((f) => f.replace(/^FROM\s+/, "")).join(", ")}`);
  }

  // Generic key-value extraction for unrecognized configs
  if (lines.length === 0) {
    const kvLines = content.split("\n").filter((l) => /^\w[\w.-]*\s*[=:]/.test(l));
    if (kvLines.length > 0) {
      lines.push(`Key settings: ${kvLines.slice(0, 15).map((l) => l.split(/[=:]/)[0].trim()).join(", ")}`);
    }
  }

  return lines.join("\n").slice(0, SUMMARY_BUDGET);
}

// --- Main entry ---

export function compressLargeContent(content: string, maxChars: number): string {
  // Content at or under the limit passes through unchanged
  if (content.length <= maxChars) return content;

  const format = detectContentFormat(content);
  const lineCount = content.split("\n").length;

  // Build structured summary
  let summary: string;
  switch (format) {
    case "json": summary = summarizeJson(content); break;
    case "yaml": summary = summarizeYaml(content); break;
    case "logs": summary = summarizeLogs(content); break;
    case "code": summary = summarizeCode(content); break;
    case "config": summary = summarizeConfig(content); break;
    case "text": summary = ""; break;
  }

  const header = `[Large content: ${format}, ~${content.length.toLocaleString("en-US")} chars, ${lineCount} lines]`;

  // Calculate how much original content we can preserve
  const headerAndSummary = summary
    ? `${header}\n${summary}\n[Original content preserved below]\n`
    : `${header}\n`;
  const overhead = headerAndSummary.length;
  const availableForOriginal = maxChars - overhead;

  if (availableForOriginal <= 0) {
    // Summary alone exceeds budget — just return truncated summary
    return `${header}\n${summary}`.slice(0, maxChars);
  }

  // Split available budget: head gets 70%, tail gets 30%
  const headBudget = Math.floor(availableForOriginal * 0.7);
  const tailBudget = availableForOriginal - headBudget;

  // For very short tail budgets, just use head
  if (tailBudget < 200) {
    return `${headerAndSummary}${content.slice(0, availableForOriginal)}`;
  }

  const head = content.slice(0, headBudget);
  const tail = content.slice(-tailBudget);
  const omitted = content.length - headBudget - tailBudget;
  const omittedMarker = `\n[... ${omitted.toLocaleString("en-US")} chars omitted ...]\n`;

  // Check if marker fits
  const totalWithMarker = overhead + headBudget + omittedMarker.length + tailBudget;
  if (totalWithMarker > maxChars) {
    // Shrink head to fit marker
    const shrink = totalWithMarker - maxChars;
    return `${headerAndSummary}${content.slice(0, headBudget - shrink)}${omittedMarker}${tail}`;
  }

  return `${headerAndSummary}${head}${omittedMarker}${tail}`;
}
