/**
 * File Sync + Transcript Sync test.
 *
 * Creates a temp workspace, starts the plugin with fileSync + transcriptSync,
 * writes files, waits for ingestion, then recalls to verify.
 *
 * Usage:
 *   CORTEX_API_KEY=your-key npx tsx tests/manual/test-filesync.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../../src/index.js";

const CORTEX_API_KEY = process.env.CORTEX_API_KEY;
if (!CORTEX_API_KEY) {
  console.error("Set CORTEX_API_KEY env var");
  process.exit(1);
}

const MARKER = `filesync-${Date.now()}`;
const WORKSPACE = join(tmpdir(), `openclaw-test-${MARKER}`);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Setup temp workspace ---
mkdirSync(join(WORKSPACE, "memory"), { recursive: true });
mkdirSync(join(WORKSPACE, "sessions"), { recursive: true });
// Create empty MEMORY.md so the watcher can attach
writeFileSync(join(WORKSPACE, "MEMORY.md"), "");

console.log(`Workspace: ${WORKSPACE}`);
console.log(`Marker: ${MARKER}\n`);

// --- Wire up plugin ---
const hooks: Record<string, Function[]> = {};
const services: Array<{ id: string; start?: Function; stop?: Function }> = [];

const api = {
  pluginConfig: {
    apiKey: CORTEX_API_KEY,
    baseUrl: "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
    autoRecall: true,
    autoCapture: false,
    recallTopK: 10,
    recallTimeoutMs: 10000,
    recallMode: "fast",
    fileSync: true,
    transcriptSync: true,
    reflectIntervalMs: 0,
    namespace: "manual-test",
  },
  logger: {
    debug: (...args: unknown[]) => console.log("  [debug]", ...args),
    info: (...args: unknown[]) => console.log("  [info]", ...args),
    warn: (...args: unknown[]) => console.warn("  [warn]", ...args),
    error: (...args: unknown[]) => console.error("  [error]", ...args),
  },
  on(hookName: string, handler: Function) {
    hooks[hookName] ??= [];
    hooks[hookName].push(handler);
  },
  registerService(svc: { id: string; start?: Function; stop?: Function }) {
    services.push(svc);
  },
};

async function recall(query: string): Promise<string | null> {
  for (const handler of hooks["before_agent_start"] ?? []) {
    const result = await handler(
      { prompt: query, messages: [] },
      { sessionId: "filesync-test" },
    );
    return result?.prependContext ?? null;
  }
  return null;
}

async function main() {
  // 1. Register and start
  console.log("=== 1. Register plugin with fileSync + transcriptSync ===");
  plugin.register(api);
  for (const svc of services) {
    svc.start?.({ workspaceDir: WORKSPACE });
  }

  // Give watchers time to attach
  await sleep(500);

  // 2. Write to MEMORY.md
  console.log("\n=== 2. Write to MEMORY.md ===");
  const memoryLine = `The project codename for file sync test is ${MARKER} and it uses Elixir.`;
  writeFileSync(join(WORKSPACE, "MEMORY.md"), `# Memory\n\n- ${memoryLine}\n`);
  console.log(`  Wrote: "${memoryLine}"`);

  // 3. Write a daily log
  console.log("\n=== 3. Write daily log ===");
  const dailyLogContent = `# 2026-02-17\n\n- Deployed ${MARKER} to production with zero downtime.\n- Migrated the ${MARKER} database to Aurora Serverless.\n`;
  writeFileSync(join(WORKSPACE, "memory", "2026-02-17.md"), dailyLogContent);
  console.log(`  Wrote: memory/2026-02-17.md`);

  // 4. Write a session transcript
  console.log("\n=== 4. Write session transcript ===");
  const transcriptLines = [
    JSON.stringify({ role: "user", content: `Tell me about the ${MARKER} deployment process.` }),
    JSON.stringify({ role: "assistant", content: `The ${MARKER} project uses a blue-green deployment strategy with automatic rollback on health check failures.` }),
  ];
  writeFileSync(join(WORKSPACE, "sessions", "test-session.jsonl"), transcriptLines.join("\n") + "\n");
  console.log(`  Wrote: sessions/test-session.jsonl`);

  // 5. Wait for debounce + ingestion
  // MEMORY.md has a 2s debounce, plus Cortex needs time to index
  console.log("\n=== 5. Waiting for debounce (3s) + ingestion + indexing (15s) ===");
  await sleep(18000);

  // 6. Recall each piece
  console.log("\n=== 6. Recall tests ===");

  let passed = 0;
  let failed = 0;

  // Test MEMORY.md
  console.log("\n  [MEMORY.md]");
  const memResult = await recall(`What is the project codename ${MARKER}?`);
  if (memResult?.includes(MARKER)) {
    console.log(`  PASS — MEMORY.md content recalled`);
    passed++;
  } else {
    console.log(`  FAIL — MEMORY.md content not found in recall`);
    console.log(`  Got: ${memResult ?? "(nothing)"}`);
    failed++;
  }

  // Test daily log
  console.log("\n  [Daily Log]");
  const dailyResult = await recall(`What happened with ${MARKER} deployment?`);
  if (dailyResult?.includes(MARKER)) {
    console.log(`  PASS — Daily log content recalled`);
    passed++;
  } else {
    console.log(`  FAIL — Daily log content not found in recall`);
    console.log(`  Got: ${dailyResult ?? "(nothing)"}`);
    failed++;
  }

  // Test transcript
  console.log("\n  [Transcript]");
  const transcriptResult = await recall(`${MARKER} deployment strategy`);
  if (transcriptResult?.includes(MARKER)) {
    console.log(`  PASS — Transcript content recalled`);
    passed++;
  } else {
    console.log(`  FAIL — Transcript content not found in recall`);
    console.log(`  Got: ${transcriptResult ?? "(nothing)"}`);
    failed++;
  }

  // 7. Stop
  console.log("\n=== 7. Stop services ===");
  for (const svc of services) {
    svc.stop?.({});
  }

  // Cleanup
  rmSync(WORKSPACE, { recursive: true, force: true });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(console.error);
