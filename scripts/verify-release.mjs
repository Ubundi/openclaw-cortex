import { readFile } from "node:fs/promises";

const errors = [];

function expectEqual(label, a, b) {
  if (a !== b) {
    errors.push(`${label}: expected "${a}" to equal "${b}"`);
  }
}

function extractOrFail(text, regex, label) {
  const match = regex.exec(text);
  if (!match) {
    errors.push(`Could not find ${label}`);
    return null;
  }
  return match[1];
}

async function main() {
  const [packageRaw, manifestRaw, pluginRaw, schemaRaw, readmeRaw] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf-8"),
    readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
    readFile(new URL("../src/core/plugin.ts", import.meta.url), "utf-8"),
    readFile(new URL("../src/core/config/schema.ts", import.meta.url), "utf-8"),
    readFile(new URL("../README.md", import.meta.url), "utf-8"),
  ]);

  const packageJson = JSON.parse(packageRaw);
  const manifest = JSON.parse(manifestRaw);

  expectEqual("Version mismatch (package.json vs openclaw.plugin.json)", packageJson.version, manifest.version);

  if (!pluginRaw.includes('import { version } from "../../package.json"')) {
    errors.push("src/core/plugin.ts must import version from ../../package.json");
  }
  if (!pluginRaw.includes("version,")) {
    errors.push("src/core/plugin.ts must use imported version field in plugin object");
  }

  const schemaTimeout = extractOrFail(
    schemaRaw,
    /recallTimeoutMs:\s*z\.number\(\)\.int\(\)\.min\(\d+\)\.max\(\d+\)\.default\((\d+)\)/,
    "schema recallTimeoutMs default",
  );
  const manifestTimeout = manifest?.configSchema?.properties?.recallTimeoutMs?.default;
  if (manifestTimeout == null) {
    errors.push("Could not find manifest recallTimeoutMs default");
  }

  const readmeConfigTimeout = extractOrFail(
    readmeRaw,
    /recallTimeoutMs:\s*(\d+)/,
    "README config example recallTimeoutMs",
  );

  const timeoutValues = [
    schemaTimeout ? Number(schemaTimeout) : null,
    manifestTimeout != null ? Number(manifestTimeout) : null,
    readmeConfigTimeout ? Number(readmeConfigTimeout) : null,
  ].filter((v) => v != null);

  if (timeoutValues.length === 3) {
    const [first, ...rest] = timeoutValues;
    for (const value of rest) {
      if (value !== first) {
        errors.push(
          `recallTimeoutMs mismatch across schema/manifest/README: ${timeoutValues.join(", ")}`,
        );
        break;
      }
    }
  }

  if (errors.length > 0) {
    console.error("verify-release failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`verify-release passed (version=${packageJson.version}, recallTimeoutMs=${timeoutValues[0] ?? manifestTimeout})`);
}

await main();
