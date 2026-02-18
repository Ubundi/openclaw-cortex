import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);
const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
);

manifest.version = packageJson.version;

writeFileSync(
  new URL("../openclaw.plugin.json", import.meta.url),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`Synced openclaw.plugin.json to v${packageJson.version}`);
