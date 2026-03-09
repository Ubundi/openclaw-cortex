#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Proxy `cortex <cmd>` → `openclaw cortex <cmd>`
try {
  execFileSync("openclaw", ["cortex", ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (err) {
  // execFileSync throws on non-zero exit — exit code already forwarded via stdio
  process.exitCode = err.status ?? 1;
}
