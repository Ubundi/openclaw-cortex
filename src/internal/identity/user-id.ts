import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const CONFIG_DIR = join(homedir(), ".openclaw");
const USER_ID_FILE = join(CONFIG_DIR, "cortex-user-id");

/**
 * Loads the persistent Cortex user ID for this installation.
 * If it doesn't exist yet, generates a new UUID, persists it, and returns it.
 * The ID is stored at ~/.openclaw/cortex-user-id and survives across sessions
 * and workspace changes.
 */
export async function loadOrCreateUserId(): Promise<string> {
  try {
    const existing = await readFile(USER_ID_FILE, "utf-8");
    const trimmed = existing.trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    // File doesn't exist yet — create it
  }

  const newId = randomUUID();
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(USER_ID_FILE, newId, "utf-8");
  } catch {
    // If we can't persist it, still return a generated ID for this session
  }
  return newId;
}
