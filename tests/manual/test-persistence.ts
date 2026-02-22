/**
 * Persistence proof — verifies that captured data actually lands in Cortex.
 *
 * 1. Remember a conversation with a unique marker
 * 2. Wait for Cortex to index it
 * 3. Recall using that marker
 * 4. Assert the marker appears in recalled memories
 *
 * Usage:
 *   CORTEX_API_KEY=your-key npx tsx tests/manual/test-persistence.ts
 */
import { CortexClient } from "../../src/adapters/cortex/client.js";

const CORTEX_API_KEY = process.env.CORTEX_API_KEY;
if (!CORTEX_API_KEY) {
  console.error("Set CORTEX_API_KEY env var");
  process.exit(1);
}

const BASE_URL = "https://q5p64iw9c9.execute-api.us-east-1.amazonaws.com/prod";
const client = new CortexClient(BASE_URL, CORTEX_API_KEY);

const MARKER = `persistence-proof-${Date.now()}`;
const WAIT_SECONDS = 15;

async function main() {
  console.log(`Marker: ${MARKER}\n`);

  // Step 1: Remember
  console.log("1. Remembering conversation with unique marker...");
  const rememberResult = await client.rememberConversation(
    [
      { role: "user", content: `The secret project codename is ${MARKER} and it uses Rust for the backend.` },
      { role: "assistant", content: `Got it! I've noted that the project codename is ${MARKER} and the backend is written in Rust.` },
    ],
    `persistence-test-${Date.now()}`,
  );
  console.log(`   Remembered: ${rememberResult.memories_created} memories, entities: ${rememberResult.entities_found.join(", ")}`);
  console.log(`   Facts: ${JSON.stringify(rememberResult.facts)}`);

  // Step 2: Wait for indexing
  console.log(`\n2. Waiting ${WAIT_SECONDS}s for Cortex to index...`);
  for (let i = WAIT_SECONDS; i > 0; i--) {
    process.stdout.write(`   ${i}s \r`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("   Done waiting.       ");

  // Step 3: Recall
  console.log("\n3. Recalling with marker query...");
  const recallResult = await client.recall(
    `What is the project codename ${MARKER}?`,
    10000,
    { limit: 10 },
  );
  console.log(`   Recalled ${recallResult.memories.length} memories`);

  // Step 4: Check
  console.log("\n4. Checking for marker in results...");
  const match = recallResult.memories.find((m) =>
    m.content.includes(MARKER),
  );

  if (match) {
    console.log(`\n   PASS — Data persisted and retrieved successfully.`);
    console.log(`   Match: "${match.content}" (confidence: ${match.confidence})`);
  } else {
    console.log(`\n   FAIL — Marker "${MARKER}" not found in recall results.`);
    console.log("   Results returned:");
    for (const m of recallResult.memories) {
      console.log(`     [${m.confidence.toFixed(2)}] ${m.content}`);
    }
  }
}

main().catch(console.error);
