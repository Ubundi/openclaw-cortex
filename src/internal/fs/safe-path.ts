import { realpath, lstat } from "node:fs/promises";

/**
 * Resolves a file path and verifies it stays within the allowed root directory.
 * Rejects symlinks and path traversal attempts.
 *
 * Returns the canonical path if safe, or null if the path should be rejected.
 */
export async function safePath(
  filePath: string,
  allowedRoot: string,
): Promise<string | null> {
  try {
    // Check for symlinks before resolving
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      return null;
    }

    // Resolve to canonical path (resolves .., ., etc.)
    const canonical = await realpath(filePath);
    const canonicalRoot = await realpath(allowedRoot);

    // Ensure the resolved path is within the allowed root
    const normalizedRoot = canonicalRoot.endsWith("/")
      ? canonicalRoot
      : canonicalRoot + "/";

    if (canonical !== canonicalRoot && !canonical.startsWith(normalizedRoot)) {
      return null;
    }

    return canonical;
  } catch {
    // File doesn't exist or is inaccessible
    return null;
  }
}
