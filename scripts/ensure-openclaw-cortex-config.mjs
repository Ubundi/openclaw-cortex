#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const PLUGIN_KEY = "openclaw-cortex";

// Shipped for managed installers that need the same config normalization as the local prelaunch script.

export function ensureOpenClawCortexConfig(input) {
  const config = input && typeof input === "object" && !Array.isArray(input)
    ? structuredClone(input)
    : {};

  if (!config.plugins || typeof config.plugins !== "object" || Array.isArray(config.plugins)) {
    config.plugins = {};
  }
  if (!config.plugins.entries || typeof config.plugins.entries !== "object" || Array.isArray(config.plugins.entries)) {
    config.plugins.entries = {};
  }

  const existingEntry = config.plugins.entries[PLUGIN_KEY];
  const entry = existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)
    ? existingEntry
    : {};
  const hooks = entry.hooks && typeof entry.hooks === "object" && !Array.isArray(entry.hooks)
    ? entry.hooks
    : {};
  const existingConfig = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
    ? entry.config
    : {};

  config.plugins.entries[PLUGIN_KEY] = {
    ...entry,
    enabled: true,
    hooks: {
      ...hooks,
      allowConversationAccess: hooks.allowConversationAccess ?? true,
    },
    config: existingConfig,
  };

  if (!config.plugins.slots || typeof config.plugins.slots !== "object" || Array.isArray(config.plugins.slots)) {
    config.plugins.slots = {};
  }
  config.plugins.slots.memory = PLUGIN_KEY;

  return config;
}

export function ensureOpenClawCortexConfigFile(configPath) {
  const raw = readFileSync(configPath, "utf8").trim();
  const parsed = raw ? JSON.parse(raw) : {};
  const next = ensureOpenClawCortexConfig(parsed);
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: ensure-openclaw-cortex-config.mjs /path/to/openclaw.json");
    process.exit(2);
  }
  ensureOpenClawCortexConfigFile(configPath);
}
