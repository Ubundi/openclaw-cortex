/**
 * Persistence proof — verifies that captured data actually lands in Cortex.
 *
 * 1. Ingest a conversation with a unique marker
 * 2. Wait for Cortex to index it
 * 3. Recall using that marker
 * 4. Assert the marker appears in recalled memories
 *
 * Usage:
 *   CORTEX_API_KEY=your-key npx tsx test-persistence.ts
 */
import { CortexClient } from "./src/client.js";

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

  // Step 1: Ingest
  console.log("1. Ingesting conversation with unique marker...");
  const ingestResult = await client.ingestConversation(
    [
      { role: "user", content: `The secret project codename is ${MARKER} and it uses Rust for the backend.` },
      { role: "assistant", content: `Got it! I've noted that the project codename is ${MARKER} and the backend is written in Rust.` },
    ],
    `persistence-test-${Date.now()}`,
  );
  console.log(`   Ingested: ${ingestResult.facts.length} facts, ${ingestResult.entities.length} entities, ${ingestResult.nodes_created} nodes created`);
  console.log(`   Facts: ${JSON.stringify(ingestResult.facts)}`);

  // Step 2: Wait for indexing
  console.log(`\n2. Waiting ${WAIT_SECONDS}s for Cortex to index...`);
  for (let i = WAIT_SECONDS; i > 0; i--) {
    process.stdout.write(`   ${i}s \r`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("   Done waiting.       ");

  // Step 3: Recall
  console.log("\n3. Recalling with marker query...");
  const retrieveResult = await client.retrieve(
    `What is the project codename ${MARKER}?`,
    10,
    "fast",
    10000,
  );
  console.log(`   Retrieved ${retrieveResult.results.length} results`);

  // Step 4: Check
  console.log("\n4. Checking for marker in results...");
  const match = retrieveResult.results.find((r) =>
    r.content.includes(MARKER),
  );

  if (match) {
    console.log(`\n   PASS — Data persisted and retrieved successfully.`);
    console.log(`   Match: "${match.content}" (score: ${match.score})`);
  } else {
    console.log(`\n   FAIL — Marker "${MARKER}" not found in recall results.`);
    console.log("   Results returned:");
    for (const r of retrieveResult.results) {
      console.log(`     [${r.score.toFixed(2)}] ${r.content}`);
    }
  }
}

main().catch(console.error);
