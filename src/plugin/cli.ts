import type { CortexClient } from "../cortex/client.js";
import type { CortexConfig } from "./config.js";
import type { CliProgram, Logger } from "./types.js";
import { coerceCliSearchQuery, coerceSearchMode, prepareSearchQuery } from "./search-query.js";

export interface SessionStats {
  saves: number;
  savesSkippedDedupe: number;
  savesSkippedNovelty: number;
  searches: number;
  recallCount: number;
  recallMemoriesTotal: number;
  recallDuplicatesCollapsed: number;
}

export interface CliDeps {
  client: CortexClient;
  config: CortexConfig;
  version: string;
  getUserId: () => string | undefined;
  userIdReady: Promise<void>;
  getNamespace: () => string;
  sessionStats: SessionStats;
  loadPersistedStats: () => SessionStats | null;
  isAbortError: (err: unknown) => boolean;
  resetCompletedAfterAbort: (client: CortexClient, userId: string) => Promise<boolean>;
}

export function registerCliCommands(
  registerCli: (
    registrar: (ctx: { program: CliProgram; config: Record<string, unknown>; workspaceDir?: string; logger: Logger }) => void,
    opts?: { commands?: string[] },
  ) => void,
  deps: CliDeps,
): void {
  const {
    client,
    config,
    version,
    getUserId,
    userIdReady,
    getNamespace,
    sessionStats,
    loadPersistedStats,
    isAbortError,
    resetCompletedAfterAbort,
  } = deps;

  registerCli(
    ({ program }) => {
      const cortex = program.command("cortex").description("Cortex memory CLI commands");

      cortex
        .command("status")
        .description("Check Cortex API health and show memory status")
        .action(async () => {
          await userIdReady;
          const userId = getUserId();

          console.log("Cortex Status Check");
          console.log("=".repeat(50));

          // Health check
          const startHealth = Date.now();
          let healthy = false;
          try {
            healthy = await client.healthCheck();
            const ms = Date.now() - startHealth;
            console.log(`  API Health:     ${healthy ? "OK" : "UNREACHABLE"} (${ms}ms)`);
          } catch {
            console.log(`  API Health:     UNREACHABLE`);
          }

          if (!healthy) {
            console.log("\nAPI is unreachable. Check baseUrl and network connectivity.");
            return;
          }

          // Link status
          if (userId) {
            try {
              const linkStatus = await client.getLinkStatus(userId);
              if (linkStatus.linked && linkStatus.link) {
                const linkedDate = new Date(linkStatus.link.linked_at).toISOString().slice(0, 10);
                console.log(`  TooToo Link:    ✓ Linked since ${linkedDate}`);
              } else {
                console.log(`  TooToo Link:    Not linked. Run \`openclaw cortex pair\` to connect.`);
              }
            } catch {
              console.log(`  TooToo Link:    Unable to check`);
            }
          }

          // Knowledge
          try {
            const startKnowledge = Date.now();
            const knowledge = await client.knowledge(undefined, userId);
            const ms = Date.now() - startKnowledge;
            console.log(`  Knowledge:      OK (${ms}ms)`);
            console.log(`    Memories:     ${knowledge.total_memories.toLocaleString()}`);
            console.log(`    Sessions:     ${knowledge.total_sessions}`);
            console.log(`    Maturity:     ${knowledge.maturity}`);
          } catch (err) {
            console.log(`  Knowledge:      FAILED — ${String(err)}`);
          }

          // Stats
          try {
            const startStats = Date.now();
            const stats = await client.stats(undefined, userId);
            const ms = Date.now() - startStats;
            console.log(`  Stats:          OK (${ms}ms)`);
            console.log(`    Pipeline:     tier ${stats.pipeline_tier}`);
          } catch (err) {
            console.log(`  Stats:          FAILED — ${String(err)}`);
          }

          // Recall
          try {
            const startRecall = Date.now();
            await client.recall("test", 5000, { limit: 1, userId });
            const ms = Date.now() - startRecall;
            console.log(`  Recall:         OK (${ms}ms)`);
          } catch (err) {
            console.log(`  Recall:         FAILED — ${String(err)}`);
          }

          // Retrieve
          try {
            const startRetrieve = Date.now();
            await client.retrieve("test", 1, "fast", 5000, undefined, { userId });
            const ms = Date.now() - startRetrieve;
            console.log(`  Retrieve:       OK (${ms}ms)`);
          } catch (err) {
            console.log(`  Retrieve:       FAILED — ${String(err)}`);
          }

          console.log("");
          console.log(`  Version:        ${version}`);
          console.log(`  User ID:        ${userId ?? "unknown"}`);
          console.log(`  Base URL:       ${config.baseUrl}`);
          console.log(`  Auto-Recall:    ${config.autoRecall ? "on" : "off"}`);
          console.log(`  Auto-Capture:   ${config.autoCapture ? "on" : "off"}`);
          console.log(`  Dedupe Window:  ${config.dedupeWindowMinutes > 0 ? `${config.dedupeWindowMinutes}min` : "off"}`);

          // Session activity stats — read from persisted file so CLI process
          // can see stats from the running gateway instance
          const liveStats = loadPersistedStats() ?? sessionStats;
          const totalSkipped = liveStats.savesSkippedDedupe + liveStats.savesSkippedNovelty;
          const avgRecallMemories = liveStats.recallCount > 0
            ? (liveStats.recallMemoriesTotal / liveStats.recallCount).toFixed(1)
            : "0";

          console.log("");
          console.log("Session Activity");
          console.log("-".repeat(50));
          console.log(`  Saves:          ${liveStats.saves}`);
          if (totalSkipped > 0) {
            console.log(`  Skipped:        ${totalSkipped} (${liveStats.savesSkippedDedupe} dedupe, ${liveStats.savesSkippedNovelty} novelty)`);
          }
          console.log(`  Searches:       ${liveStats.searches}`);
          console.log(`  Recalls:        ${liveStats.recallCount}`);
          console.log(`  Avg memories/recall: ${avgRecallMemories}`);
          if (liveStats.recallDuplicatesCollapsed > 0) {
            console.log(`  Duplicates collapsed: ${liveStats.recallDuplicatesCollapsed}`);
          }
        });

      cortex
        .command("memories")
        .description("Show memory count and maturity")
        .action(async () => {
          await userIdReady;
          const userId = getUserId();

          try {
            const knowledge = await client.knowledge(undefined, userId);
            console.log(`Memories:  ${knowledge.total_memories.toLocaleString()}`);
            console.log(`Sessions:  ${knowledge.total_sessions}`);
            console.log(`Maturity:  ${knowledge.maturity}`);

            if (knowledge.entities.length > 0) {
              console.log(`\nTop Entities:`);
              knowledge.entities.slice(0, 10).forEach((e) => {
                console.log(`  ${e.name} (${e.memory_count} memories, last seen ${e.last_seen})`);
              });
            }
          } catch (err) {
            console.error(`Failed: ${String(err)}`);
            process.exitCode = 1;
          }
        });

      cortex
        .command("search")
        .description("Search memories from the terminal")
        .argument("[query...]", "Search query")
        .option("--limit <n>", "Max results", "10")
        .option("--mode <mode>", "Search mode: all, decisions, preferences, facts, recent")
        .action(async (queryInput: string[] | string | undefined, opts: { limit: string; mode?: string }) => {
          await userIdReady;
          const userId = getUserId();
          const query = coerceCliSearchQuery(queryInput);

          if (!query) {
            console.error("Search failed: provide a query, for example `openclaw cortex search what database did we choose`.");
            process.exitCode = 1;
            return;
          }

          const prepared = prepareSearchQuery(query, coerceSearchMode(opts.mode));

          try {
            const response = await client.recall(prepared.effectiveQuery, config.toolTimeoutMs, {
              limit: parseInt(opts.limit),
              userId,
              queryType: prepared.queryType,
              memoryType: prepared.memoryType,
            });

            if (!response.memories?.length) {
              console.log(`No memories found for: "${query}"`);
              return;
            }

            console.log(`Found ${response.memories.length} memories (mode: ${prepared.mode}):\n`);
            response.memories.forEach((m, i) => {
              const displayScore = m.relevance ?? m.confidence;
              console.log(`${i + 1}. [${displayScore.toFixed(2)}] ${m.content}`);
              if (m.entities.length > 0) {
                console.log(`   entities: ${m.entities.join(", ")}`);
              }
              console.log("");
            });
          } catch (err) {
            console.error(`Search failed: ${String(err)}`);
            process.exitCode = 1;
          }
        });

      cortex
        .command("config")
        .description("Show current Cortex plugin configuration")
        .action(async () => {
          await userIdReady;
          const userId = getUserId();
          console.log(`Version:          ${version}`);
          console.log(`Base URL:         ${config.baseUrl}`);
          console.log(`User ID:          ${userId ?? "unknown"}`);
          console.log(`Namespace:        ${getNamespace()}`);
          console.log(`Auto-Recall:      ${config.autoRecall ? "on" : "off"}`);
          console.log(`Auto-Capture:     ${config.autoCapture ? "on" : "off"}`);
          console.log(`Recall Limit:     ${config.recallLimit}`);
          console.log(`Recall Timeout:   ${config.recallTimeoutMs}ms`);
          console.log(`Tool Timeout:     ${config.toolTimeoutMs}ms`);
          console.log(`Audit Log:        ${config.auditLog ? "on" : "off"}`);
        });

      cortex
        .command("pair")
        .description("Generate a TooToo pairing code to link your agent")
        .action(async () => {
          await userIdReady;
          const userId = getUserId();
          if (!userId) {
            console.error("Cannot generate pairing code: user ID not available.");
            process.exitCode = 1;
            return;
          }

          try {
            const { user_code, expires_in } = await client.generatePairingCode(userId);
            const mins = Math.floor(expires_in / 60);
            console.log(`
  TooToo Agent Pairing
  ${"=".repeat(46)}

  TooToo (https://tootoo.ai) is a personal discovery platform that
  builds a living codex of your values, beliefs, principles, and
  goals through interactive journeys.

  By pairing your agent, conversations you have with your AI agent
  are automatically analyzed for personal insights — values you
  express, beliefs you hold, decisions you make — and surfaced as
  suggestions in your TooToo codex.

  This means your day-to-day work conversations quietly contribute
  to your self-knowledge, without any extra effort.

  Your pairing details
  ${"-".repeat(46)}

    Agent ID:      ${userId}
    Pairing code:  ${user_code}
    Expires in:    ${mins} minute${mins !== 1 ? "s" : ""}

  How to connect
  ${"-".repeat(46)}

    1. Go to https://tootoo.ai/settings/agents
    2. Click "Connect Agent"
    3. Enter the pairing code above

  Once linked, codex suggestions from your agent conversations
  will appear in your TooToo codex automatically. You can unlink
  at any time from the TooToo settings page.
`);
          } catch (err) {
            console.error(`Failed to generate pairing code: ${String(err)}`);
            process.exitCode = 1;
          }
        });
      cortex
        .command("info")
        .description("Learn what Cortex does and how it works")
        .action(async () => {
          console.log(`
  Cortex Memory — v${version}
  ${"=".repeat(46)}

  Cortex gives your AI agent persistent long-term memory that spans
  across sessions, projects, and conversations. It remembers what
  matters and surfaces it when relevant — automatically.

  How it works
  ${"-".repeat(46)}

  Auto-Capture    After each conversation turn, Cortex extracts key
                  facts, decisions, and context from the exchange and
                  stores them in a knowledge graph.

  Auto-Recall     Before the agent responds, Cortex searches your
                  memory for anything relevant to the current query
                  and injects it into the agent's context.

  The more you use your agent, the smarter recall gets. Cortex
  adapts its retrieval pipeline as your memory store grows:

    Tier 1  →  Fast flat retrieval (few memories)
    Tier 2  →  Reranking for relevance (moderate)
    Tier 3  →  Graph traversal + reranking (mature)

  Commands
  ${"-".repeat(46)}

    cortex status     API health, memory count, session activity
    cortex memories   Memory count, maturity, top entities
    cortex search     Search your memories from the terminal
    cortex config     Show current plugin configuration
    cortex pair       Link your agent to TooToo
    cortex reset      Delete all memories (irreversible)
    cortex info       This page

  In-chat tools
  ${"-".repeat(46)}

    cortex_search_memory   Search memories during a conversation
    cortex_save_memory     Explicitly save a memory

  Learn more at https://github.com/Ubundi/openclaw-cortex
`);
        });

      cortex
        .command("reset")
        .description("Permanently delete ALL memories for this agent (irreversible)")
        .option("--yes", "Skip confirmation prompt")
        .action(async (opts: { yes?: boolean }) => {
          await userIdReady;
          const userId = getUserId();
          if (!userId) {
            console.error("Cannot reset: user ID not available.");
            process.exitCode = 1;
            return;
          }

          // Show what will be deleted
          let memoryCount = 0;
          let sessionCount = 0;
          try {
            const knowledge = await client.knowledge(undefined, userId);
            memoryCount = knowledge.total_memories;
            sessionCount = knowledge.total_sessions;
          } catch {
            // Continue even if we can't get counts
          }

          console.log("");
          console.log("  WARNING: This will permanently delete ALL data for this agent.");
          console.log("");
          console.log(`  Agent ID:   ${userId}`);
          if (memoryCount > 0 || sessionCount > 0) {
            console.log(`  Memories:   ${memoryCount.toLocaleString()}`);
            console.log(`  Sessions:   ${sessionCount}`);
          }
          console.log("");
          console.log("  This includes all memories, facts, suggestions, and graph data.");
          console.log("  Agent links (TooToo pairing) will be preserved.");
          console.log("  This action CANNOT be undone.");
          console.log("");

          if (!opts.yes) {
            const { createInterface } = await import("node:readline");
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>((resolve) => {
              rl.question("  Type 'reset' to confirm: ", resolve);
            });
            rl.close();

            if (answer.trim().toLowerCase() !== "reset") {
              console.log("\n  Aborted. No data was deleted.");
              return;
            }
          }

          try {
            const result = await client.forgetUser(userId);
            const d = result.deleted;
            console.log("");
            console.log("  Memory reset complete.");
            console.log("");
            console.log(`  Deleted:`);
            console.log(`    Engraved memories:  ${d.engraved_memories}`);
            console.log(`    Resonated memories: ${d.resonated_memories}`);
            console.log(`    Graph nodes:        ${d.nodes}`);
            console.log(`    Codex suggestions:  ${d.codex_suggestions}`);
            console.log(`    Suppressions:       ${d.codex_suggestion_suppressions}`);
          } catch (err) {
            const is503 = /50[23]/.test(String(err));
            if ((isAbortError(err) || is503) && await resetCompletedAfterAbort(client, userId)) {
              console.log("");
              console.log("  Memory reset complete.");
              console.log("");
              console.log("  The server finished the reset, but the response timed out before deletion stats were returned.");
              return;
            }
            console.error(`\n  Reset failed: ${String(err)}`);
            process.exitCode = 1;
          }
        });
    },
    { commands: ["cortex"] },
  );
}
