#!/usr/bin/env node
/**
 * Post-build script: replaces __OPENCLAW_API_KEY__ placeholder in compiled
 * dist files with the value of the BUILD_API_KEY environment variable.
 *
 * Usage:
 *   BUILD_API_KEY=your-key npm run build
 *
 * If BUILD_API_KEY is not set the placeholder is left as-is, which will cause
 * the plugin to fail at runtime — intentional, so a bad build is visible.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const apiKey = process.env.BUILD_API_KEY;

if (!apiKey) {
  console.error("[inject-api-key] BUILD_API_KEY is not set — placeholder left in dist, plugin will not work");
  process.exit(1);
}

const distDir = join(fileURLToPath(import.meta.url), "../../dist");
const targetFile = join(distDir, "internal/api-key.js");

try {
  const content = readFileSync(targetFile, "utf-8");
  const replaced = content.replace(/__OPENCLAW_API_KEY__/g, apiKey);
  if (replaced === content) {
    console.warn("[inject-api-key] Warning: placeholder not found in dist file — already replaced?");
  } else {
    writeFileSync(targetFile, replaced, "utf-8");
    console.log("[inject-api-key] API key injected successfully");
  }
} catch (err) {
  console.error("[inject-api-key] Failed to inject API key:", err.message);
  process.exit(1);
}
