#!/usr/bin/env node

import { resolve } from "node:path";

import { writeHtmlReport } from "./lib/cortex-audit-report.mjs";

async function main() {
  const [bundleDirArg, userIdPathArg, outputPathArg] = process.argv.slice(2);

  if (!bundleDirArg || !userIdPathArg || !outputPathArg) {
    console.error("Usage: node scripts/generate-cortex-value-report.mjs <bundle-dir> <user-id-file> <output-html>");
    process.exit(1);
  }

  const bundleDir = resolve(bundleDirArg);
  const userIdPath = resolve(userIdPathArg);
  const outputPath = resolve(outputPathArg);

  const report = await writeHtmlReport(bundleDir, userIdPath, outputPath);
  console.log(`Generated Cortex value report for ${report.instanceLabel}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Session: ${report.sessionId ?? "unknown"}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
