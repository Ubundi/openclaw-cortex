/**
 * OpenClaw agent simulation — full lifecycle test.
 *
 * Simulates a multi-turn coding session where:
 *   1. User sends a prompt
 *   2. before_agent_start fires → Cortex recalls relevant memories
 *   3. Agent "thinks" using the prompt + recalled context
 *   4. agent_end fires → Cortex captures the conversation
 *
 * Usage:
 *   CORTEX_API_KEY=your-key npx tsx tests/manual/test-harness.ts
 */
import plugin from "../../src/index.js";

const CORTEX_API_KEY = process.env.CORTEX_API_KEY;
if (!CORTEX_API_KEY) {
  console.error("Set CORTEX_API_KEY env var");
  process.exit(1);
}

// --- Plugin wiring (simulates OpenClaw internals) ---

const hooks: Record<string, Function[]> = {};
const services: Array<{ id: string; start?: Function; stop?: Function }> = [];

const api = {
  pluginConfig: {
    apiKey: CORTEX_API_KEY,
    baseUrl: "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod",
    autoRecall: true,
    autoCapture: true,
    recallTopK: 5,
    recallTimeoutMs: 10000,
    recallMode: "fast",
    fileSync: false,
    transcriptSync: false,
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

// --- Simulated agent ---

/**
 * Fake agent that "responds" based on the user prompt and any recalled context.
 * In real OpenClaw this would be an LLM call.
 */
function simulateAgentResponse(userPrompt: string, recalledContext: string | null): string {
  if (recalledContext) {
    return `Based on what I remember:\n${recalledContext}\n\nHere's my response to "${userPrompt}": I'll use the context above to give you a more informed answer. Let me work on that.`;
  }
  return `I don't have any prior context about this. Here's my response to "${userPrompt}": Let me start fresh and help you with that.`;
}

// --- Agent turn lifecycle ---

async function agentTurn(turnNumber: number, userPrompt: string, conversationHistory: Array<{ role: string; content: string }>) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TURN ${turnNumber}`);
  console.log(`${"=".repeat(60)}`);

  // User sends prompt
  console.log(`\n> User: ${userPrompt}`);
  conversationHistory.push({ role: "user", content: userPrompt });

  // --- HOOK: before_agent_start ---
  // OpenClaw fires this before the agent processes the turn.
  // The plugin queries Cortex and returns prependContext.
  console.log("\n[before_agent_start] Recalling from Cortex...");
  let recalledContext: string | null = null;

  for (const handler of hooks["before_agent_start"] ?? []) {
    const result = await handler(
      { prompt: userPrompt, messages: conversationHistory },
      { sessionId: "sim-session" },
    );
    if (result?.prependContext) {
      recalledContext = result.prependContext;
      const memCount = (recalledContext!.match(/\n- /g) || []).length;
      console.log(`[before_agent_start] ${memCount} memories recalled`);
      console.log(recalledContext);
    } else {
      console.log("[before_agent_start] No relevant memories found");
    }
  }

  // --- Agent processes the turn ---
  // In OpenClaw, the recalled context would be prepended to the system prompt
  // before sending to the LLM. We simulate that here.
  console.log("\n[agent] Generating response...");
  const agentResponse = simulateAgentResponse(userPrompt, recalledContext);
  console.log(`\n< Agent: ${agentResponse}`);
  conversationHistory.push({ role: "assistant", content: agentResponse });

  // --- HOOK: agent_end ---
  // OpenClaw fires this after the agent finishes its turn.
  // The plugin sends the recent messages to Cortex for ingestion.
  console.log("\n[agent_end] Capturing conversation to Cortex...");
  for (const handler of hooks["agent_end"] ?? []) {
    await handler({
      messages: conversationHistory.slice(-20), // last 20 messages like the real plugin
      sessionId: "sim-session",
    });
  }
  console.log("[agent_end] Capture sent");
}

// --- Main simulation ---

async function main() {
  console.log("OpenClaw Agent Simulation");
  console.log("========================\n");

  // Boot
  plugin.register(api);
  for (const svc of services) {
    svc.start?.({ workspaceDir: process.cwd() });
  }
  console.log("Plugin loaded and services started.\n");

  const history: Array<{ role: string; content: string }> = [];

  // Simulate a realistic multi-turn coding session
  const userPrompts = [
    "What database does this project use?",
    "Can you help me add a new index to the users table for faster lookups?",
    "Actually, what language is the backend written in?",
    "Let's add a caching layer in front of the database queries. What would you recommend?",
  ];

  for (let i = 0; i < userPrompts.length; i++) {
    await agentTurn(i + 1, userPrompts[i], history);

    // Small pause between turns (simulates user thinking)
    if (i < userPrompts.length - 1) {
      console.log("\n  ... (user thinking) ...");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Shutdown
  console.log(`\n${"=".repeat(60)}`);
  console.log("SESSION END");
  console.log(`${"=".repeat(60)}`);
  for (const svc of services) {
    svc.stop?.({});
  }

  console.log(`\nTotal turns: ${userPrompts.length}`);
  console.log(`Messages captured: ${history.length}`);
}

main().catch(console.error);
