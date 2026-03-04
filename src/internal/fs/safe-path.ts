import { realpath, lstat } from "node:fs/promises";

export type SafePathFailureReason = "unsafe" | "not_found" | "io_error";

export type SafePathCheckResult =
  | { ok: true; path: string }
  | { ok: false; reason: SafePathFailureReason; errorCode?: string };

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
  const result = await safePathCheck(filePath, allowedRoot);
  return result.ok ? result.path : null;
}

/**
 * Structured safe-path validation that distinguishes true safety violations
 * from transient filesystem states (e.g. file not found during rename).
 */
export async function safePathCheck(
  filePath: string,
  allowedRoot: string,
): Promise<SafePathCheckResult> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      return { ok: false, reason: "unsafe" };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "not_found", errorCode: code };
    return { ok: false, reason: "io_error", errorCode: code };
  }

  try {
    const canonical = await realpath(filePath);
    const canonicalRoot = await realpath(allowedRoot);
    // Ensure the resolved path is within the allowed root
    const normalizedRoot = canonicalRoot.endsWith("/")
      ? canonicalRoot
      : canonicalRoot + "/";

    if (canonical !== canonicalRoot && !canonical.startsWith(normalizedRoot)) {
      return { ok: false, reason: "unsafe" };
    }

    return { ok: true, path: canonical };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "not_found", errorCode: code };
    return { ok: false, reason: "io_error", errorCode: code };
  }
}
