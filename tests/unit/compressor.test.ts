import { describe, it, expect } from "vitest";
import {
  compressLargeContent,
  detectContentFormat,
  summarizeJson,
  summarizeLogs,
  summarizeCode,
  summarizeConfig,
  summarizeYaml,
} from "../../src/features/capture/compressor.js";

// --- Format detection ---

describe("detectContentFormat", () => {
  it("detects valid JSON object", () => {
    const json = JSON.stringify({ database: { host: "localhost", port: 5432 }, redis: { host: "localhost" } });
    expect(detectContentFormat(json)).toBe("json");
  });

  it("detects valid JSON array", () => {
    const json = JSON.stringify([{ id: 1 }, { id: 2 }]);
    expect(detectContentFormat(json)).toBe("json");
  });

  it("detects truncated/malformed JSON", () => {
    const truncated = '{"database":{"host":"localhost","port":5432,"pool":{"min":2,"max":10';
    expect(detectContentFormat(truncated)).toBe("json");
  });

  it("detects YAML with --- header", () => {
    const yaml = "---\nname: myapp\nversion: 1.0\nservices:\n  web:\n    port: 3000\n";
    expect(detectContentFormat(yaml)).toBe("yaml");
  });

  it("detects YAML without --- header", () => {
    const yaml = "name: myapp\nversion: 1.0\nport: 3000\nhost: localhost\n";
    expect(detectContentFormat(yaml)).toBe("yaml");
  });

  it("detects log output", () => {
    const logs = [
      "2026-03-15T10:00:01Z INFO  Starting server",
      "2026-03-15T10:00:02Z INFO  Listening on port 3000",
      "2026-03-15T10:00:03Z WARN  Connection slow",
      "2026-03-15T10:00:04Z ERROR Connection refused",
    ].join("\n");
    expect(detectContentFormat(logs)).toBe("logs");
  });

  it("detects Python code", () => {
    const code = "import asyncio\nfrom dataclasses import dataclass\n\ndef main():\n    pass\n";
    expect(detectContentFormat(code)).toBe("code");
  });

  it("detects JavaScript/TypeScript code", () => {
    const code = 'import { readFile } from "fs";\n\nexport function process() {\n  return 42;\n}\n';
    expect(detectContentFormat(code)).toBe("code");
  });

  it("detects nginx config", () => {
    const config = "server {\n  listen 80;\n  location / {\n    proxy_pass http://backend;\n  }\n}\n";
    expect(detectContentFormat(config)).toBe("config");
  });

  it("detects Dockerfile", () => {
    const config = "FROM node:20-alpine\nRUN npm ci\nCOPY . .\nCMD [\"node\", \"index.js\"]\n";
    expect(detectContentFormat(config)).toBe("config");
  });

  it("detects docker-compose as YAML", () => {
    const config = "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\nvolumes:\n  data:\n";
    expect(detectContentFormat(config)).toBe("yaml");
  });

  it("falls back to text for unstructured content", () => {
    const text = "This is just a regular paragraph of text that doesn't match any format.";
    expect(detectContentFormat(text)).toBe("text");
  });
});

// --- JSON summarizer ---

describe("summarizeJson", () => {
  it("summarizes a JSON object with nested keys", () => {
    const json = JSON.stringify({
      database: { host: "db.prod", port: 5432, pool: { min: 2, max: 10 } },
      redis: { host: "redis.prod", ttl: 3600 },
      auth: { provider: "oauth2" },
    });
    const summary = summarizeJson(json);
    expect(summary).toContain("Top-level keys");
    expect(summary).toContain("database");
    expect(summary).toContain("redis");
    expect(summary).toContain("auth");
  });

  it("summarizes a JSON array", () => {
    const json = JSON.stringify([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
    const summary = summarizeJson(json);
    expect(summary).toContain("Array with 2 items");
    expect(summary).toContain("Item keys");
  });

  it("handles malformed JSON gracefully", () => {
    const broken = '{"database":{"host":"localhost","port":5432';
    const summary = summarizeJson(broken);
    expect(summary).toContain("Detected keys");
    expect(summary).toContain("database");
  });

  it("handles empty JSON object", () => {
    const summary = summarizeJson("{}");
    expect(summary).toContain("0 keys");
  });
});

// --- Log summarizer ---

describe("summarizeLogs", () => {
  it("extracts time range and level counts", () => {
    const logs = [
      "2026-03-15T10:00:01Z INFO  Starting server",
      "2026-03-15T10:00:02Z INFO  Listening",
      "2026-03-15T10:00:03Z WARN  Slow query",
      "2026-03-15T10:05:23Z ERROR Connection refused to redis:6379",
    ].join("\n");
    const summary = summarizeLogs(logs);
    expect(summary).toContain("Time range");
    expect(summary).toContain("10:00:01");
    expect(summary).toContain("10:05:23");
    expect(summary).toContain("INFO=2");
    expect(summary).toContain("WARN=1");
    expect(summary).toContain("ERROR=1");
  });

  it("deduplicates repeated errors with counts", () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(`2026-03-15T10:0${i}:00Z ERROR Connection refused to redis:6379`);
    }
    lines.push("2026-03-15T10:05:00Z ERROR Timeout waiting for pool");
    const summary = summarizeLogs(lines.join("\n"));
    expect(summary).toContain("Error summary");
    expect(summary).toContain("x5");
  });

  it("normalizes WARNING to WARN", () => {
    const logs = "2026-03-15T10:00:01Z WARNING Deprecation notice\n2026-03-15T10:00:02Z WARNING Another\n2026-03-15T10:00:03Z INFO ok\n";
    const summary = summarizeLogs(logs);
    expect(summary).toContain("WARN=2");
    expect(summary).not.toContain("WARNING");
  });
});

// --- Code summarizer ---

describe("summarizeCode", () => {
  it("extracts Python imports, classes, and functions", () => {
    const code = [
      "import asyncio",
      "from structlog import get_logger",
      "",
      "class RetrievalPipeline:",
      "    def retrieve(self):",
      "        pass",
      "",
      "def fuse_results():",
      "    pass",
    ].join("\n");
    const summary = summarizeCode(code);
    expect(summary).toContain("Python");
    expect(summary).toContain("asyncio");
    expect(summary).toContain("structlog");
    expect(summary).toContain("RetrievalPipeline");
    expect(summary).toContain("fuse_results");
  });

  it("extracts JS/TS imports and exports", () => {
    const code = [
      'import { readFile } from "fs";',
      'import express from "express";',
      "",
      "export function handleRequest() {}",
      "export async function processData() {}",
    ].join("\n");
    const summary = summarizeCode(code);
    expect(summary).toContain("JavaScript/TypeScript");
    expect(summary).toContain("fs");
    expect(summary).toContain("express");
    expect(summary).toContain("handleRequest");
    expect(summary).toContain("processData");
  });

  it("handles code with no imports", () => {
    const code = "function add(a, b) {\n  return a + b;\n}\n";
    const summary = summarizeCode(code);
    expect(summary).toContain("add");
  });
});

// --- Config summarizer ---

describe("summarizeConfig", () => {
  it("extracts nginx blocks", () => {
    const config = "server {\n  listen 80;\n  location /api {\n    proxy_pass http://backend;\n  }\n}\n";
    const summary = summarizeConfig(config);
    expect(summary).toContain("Nginx blocks");
    expect(summary).toContain("server");
    expect(summary).toContain("location /api");
  });

  it("extracts Dockerfile base images", () => {
    const config = "FROM node:20-alpine AS builder\nRUN npm ci\nFROM node:20-alpine\nCOPY --from=builder /app .\n";
    const summary = summarizeConfig(config);
    expect(summary).toContain("Base images");
    expect(summary).toContain("node:20-alpine");
  });

  it("falls back to key-value extraction", () => {
    const config = "max_connections=100\ntimeout=30\nlog_level=info\n";
    const summary = summarizeConfig(config);
    expect(summary).toContain("Key settings");
    expect(summary).toContain("max_connections");
  });
});

// --- YAML summarizer ---

describe("summarizeYaml", () => {
  it("extracts top-level keys", () => {
    const yaml = "name: myapp\nversion: 1.0\nservices:\n  web:\n    port: 3000\ndatabases:\n  main: postgres\n";
    const summary = summarizeYaml(yaml);
    expect(summary).toContain("name");
    expect(summary).toContain("version");
    expect(summary).toContain("services");
    expect(summary).toContain("databases");
  });
});

// --- Main compressor ---

describe("compressLargeContent", () => {
  it("passes through content under the limit", () => {
    const content = "short message";
    expect(compressLargeContent(content, 10_000)).toBe(content);
  });

  it("passes through content exactly at the limit", () => {
    const content = "x".repeat(10_000);
    expect(compressLargeContent(content, 10_000)).toBe(content);
  });

  it("compresses JSON content over the limit", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      obj[`key_${i}`] = { value: "x".repeat(100), nested: { a: i, b: `val_${i}` } };
    }
    const content = JSON.stringify(obj, null, 2);
    expect(content.length).toBeGreaterThan(10_000);

    const compressed = compressLargeContent(content, 10_000);
    expect(compressed.length).toBeLessThanOrEqual(10_000);
    expect(compressed).toContain("[Large content: json");
    expect(compressed).toContain("Top-level keys");
  });

  it("compresses log content over the limit", () => {
    const lines = [];
    for (let i = 0; i < 500; i++) {
      const level = i % 50 === 0 ? "ERROR" : "INFO";
      lines.push(`2026-03-15T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z ${level}  Message number ${i} ${"x".repeat(30)}`);
    }
    const content = lines.join("\n");
    expect(content.length).toBeGreaterThan(10_000);

    const compressed = compressLargeContent(content, 10_000);
    expect(compressed.length).toBeLessThanOrEqual(10_000);
    expect(compressed).toContain("[Large content: logs");
    expect(compressed).toContain("Log levels");
  });

  it("compresses code content over the limit", () => {
    const codeLines = ['import asyncio', 'from dataclasses import dataclass', ''];
    for (let i = 0; i < 200; i++) {
      codeLines.push(`def function_${i}():`);
      codeLines.push(`    """Docstring for function ${i}"""`);
      codeLines.push(`    return ${i}`);
      codeLines.push('');
    }
    const content = codeLines.join("\n");
    expect(content.length).toBeGreaterThan(10_000);

    const compressed = compressLargeContent(content, 10_000);
    expect(compressed.length).toBeLessThanOrEqual(10_000);
    expect(compressed).toContain("[Large content: code");
    expect(compressed).toContain("Python");
  });

  it("compresses unstructured text with head/tail preservation", () => {
    const content = "A".repeat(5000) + "MIDDLE" + "B".repeat(5000);
    const compressed = compressLargeContent(content, 10_000);
    expect(compressed.length).toBeLessThanOrEqual(10_000);
    expect(compressed).toContain("[Large content: text");
    expect(compressed).toContain("chars omitted");
  });

  it("handles empty content at boundary", () => {
    const content = " ".repeat(10_001);
    const compressed = compressLargeContent(content, 10_000);
    expect(compressed.length).toBeLessThanOrEqual(10_000);
  });

  it("preserves head and tail of original content", () => {
    const head = "HEAD_MARKER_START ";
    const tail = " TAIL_MARKER_END";
    const content = head + "x".repeat(15_000) + tail;
    const compressed = compressLargeContent(content, 10_000);
    expect(compressed).toContain("HEAD_MARKER_START");
    expect(compressed).toContain("TAIL_MARKER_END");
  });

  it("handles mixed content (JSON in markdown)", () => {
    // Starts with text, not JSON — should detect as text
    const content = "Here is the config:\n```json\n" + JSON.stringify({ a: 1 }) + "\n```\n" + "x".repeat(10_000);
    const compressed = compressLargeContent(content, 10_000);
    expect(compressed.length).toBeLessThanOrEqual(10_000);
  });

  it("never exceeds maxChars regardless of format", () => {
    const formats = [
      // JSON
      JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, "x".repeat(100)]))),
      // Logs
      Array.from({ length: 1000 }, (_, i) => `2026-03-15T10:00:${String(i % 60).padStart(2, "0")}Z INFO msg ${i}`).join("\n"),
      // Code
      Array.from({ length: 500 }, (_, i) => `def fn_${i}(): pass`).join("\n"),
      // Text
      "x".repeat(50_000),
    ];

    for (const content of formats) {
      const compressed = compressLargeContent(content, 10_000);
      expect(compressed.length).toBeLessThanOrEqual(10_000);
    }
  });

  it("uses different maxChars values correctly", () => {
    const content = "x".repeat(20_000);
    expect(compressLargeContent(content, 5_000).length).toBeLessThanOrEqual(5_000);
    expect(compressLargeContent(content, 15_000).length).toBeLessThanOrEqual(15_000);
  });
});
