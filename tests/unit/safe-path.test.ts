import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, symlink, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safePath } from "../../src/shared/fs/safe-path.js";

describe("safePath", () => {
  let root: string;
  let outsideDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "safepath-root-"));
    outsideDir = await mkdtemp(join(tmpdir(), "safepath-outside-"));

    // Create a normal file inside root
    await writeFile(join(root, "legit.md"), "safe content");

    // Create a subdirectory with a file
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "nested.md"), "nested content");

    // Create a file outside the root
    await writeFile(join(outsideDir, "secret.md"), "secret data");

    // Create a symlink inside root pointing outside
    await symlink(join(outsideDir, "secret.md"), join(root, "escape-link.md"));

    // Create a symlink dir inside root pointing outside
    await symlink(outsideDir, join(root, "escape-dir"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("allows a normal file inside the root", async () => {
    const result = await safePath(join(root, "legit.md"), root);
    expect(result).not.toBeNull();
    expect(result).toContain("legit.md");
  });

  it("allows a nested file inside the root", async () => {
    const result = await safePath(join(root, "sub", "nested.md"), root);
    expect(result).not.toBeNull();
    expect(result).toContain("nested.md");
  });

  it("rejects a symlink pointing outside the root", async () => {
    const result = await safePath(join(root, "escape-link.md"), root);
    expect(result).toBeNull();
  });

  it("rejects a path with .. that escapes the root", async () => {
    const escaped = join(root, "..", "safepath-outside-" + outsideDir.split("safepath-outside-")[1], "secret.md");
    const result = await safePath(escaped, root);
    expect(result).toBeNull();
  });

  it("rejects a nonexistent file", async () => {
    const result = await safePath(join(root, "does-not-exist.md"), root);
    expect(result).toBeNull();
  });

  it("rejects a symlink directory inside the root", async () => {
    const result = await safePath(join(root, "escape-dir"), root);
    expect(result).toBeNull();
  });
});
