import type { CortexClient } from "../cortex/client.js";

export type WritePathStatus = "unknown" | "healthy" | "degraded" | "failing";

export interface WriteHealthState {
  status: WritePathStatus;
  lastAttemptAt: number;
  lastAcceptedAt: number;
  lastConfirmedAt: number;
  lastFailureAt: number;
  lastJobId?: string;
  lastJobStatus?: string;
  lastWarning?: string;
  consecutivePendingJobs: number;
  consecutiveFailures: number;
}

export interface JobProgressProbeResult {
  state: "confirmed" | "pending" | "failed" | "unknown";
  status: string;
  error?: string;
}

const SUCCESS_JOB_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "success",
  "done",
]);

const FAILED_JOB_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
  "timeout",
  "timed_out",
]);

const PENDING_JOB_STATUSES = new Set([
  "accepted",
  "pending",
  "queued",
  "running",
  "processing",
  "in_progress",
]);

function normalizeStatus(status: string | undefined | null): string {
  return String(status ?? "unknown").trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWriteHealthState(): WriteHealthState {
  return {
    status: "unknown",
    lastAttemptAt: 0,
    lastAcceptedAt: 0,
    lastConfirmedAt: 0,
    lastFailureAt: 0,
    consecutivePendingJobs: 0,
    consecutiveFailures: 0,
  };
}

export function classifyJobStatus(status: string | undefined | null): JobProgressProbeResult["state"] {
  const normalized = normalizeStatus(status);
  if (SUCCESS_JOB_STATUSES.has(normalized)) return "confirmed";
  if (FAILED_JOB_STATUSES.has(normalized)) return "failed";
  if (PENDING_JOB_STATUSES.has(normalized)) return "pending";
  return "unknown";
}

export async function probeJobProgress(
  client: Pick<CortexClient, "getJob">,
  jobId: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<JobProgressProbeResult> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const intervalMs = Math.max(0, options.intervalMs ?? 250);

  let lastStatus = "unknown";
  let lastError: string | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const job = await client.getJob(jobId);
      lastStatus = String(job.status ?? "unknown");
      const state = classifyJobStatus(lastStatus);
      if (state !== "pending" || attempt === attempts - 1) {
        return {
          state,
          status: lastStatus,
          error: typeof job.error === "string" ? job.error : undefined,
        };
      }
    } catch (err) {
      lastError = String(err);
      if (attempt === attempts - 1) {
        return { state: "unknown", status: lastStatus, error: lastError };
      }
    }

    if (attempt < attempts - 1 && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }

  return {
    state: classifyJobStatus(lastStatus),
    status: lastStatus,
    error: lastError,
  };
}

export function markWriteAccepted(
  state: WriteHealthState,
  details: { warning: string; jobId?: string; jobStatus?: string },
): void {
  const now = Date.now();
  state.status = "degraded";
  state.lastAttemptAt = now;
  state.lastAcceptedAt = now;
  state.lastWarning = details.warning;
  state.lastJobId = details.jobId;
  state.lastJobStatus = details.jobStatus;
  state.consecutivePendingJobs += 1;
  state.consecutiveFailures = 0;
}

export function markWriteConfirmed(
  state: WriteHealthState,
  details: { jobId?: string; jobStatus?: string; warning?: string } = {},
): void {
  const now = Date.now();
  state.status = "healthy";
  state.lastAttemptAt = now;
  state.lastAcceptedAt = state.lastAcceptedAt || now;
  state.lastConfirmedAt = now;
  state.lastWarning = details.warning;
  state.lastJobId = details.jobId ?? state.lastJobId;
  state.lastJobStatus = details.jobStatus ?? state.lastJobStatus;
  state.consecutivePendingJobs = 0;
  state.consecutiveFailures = 0;
}

export function markWritePending(
  state: WriteHealthState,
  details: { warning: string; jobId?: string; jobStatus?: string },
): void {
  const now = Date.now();
  state.status = "degraded";
  state.lastAttemptAt = now;
  state.lastWarning = details.warning;
  state.lastJobId = details.jobId ?? state.lastJobId;
  state.lastJobStatus = details.jobStatus ?? state.lastJobStatus;
  state.consecutivePendingJobs += 1;
  state.consecutiveFailures = 0;
}

export function markWriteFailed(
  state: WriteHealthState,
  details: { warning: string; jobId?: string; jobStatus?: string },
): void {
  const now = Date.now();
  state.status = "failing";
  state.lastAttemptAt = now;
  state.lastFailureAt = now;
  state.lastWarning = details.warning;
  state.lastJobId = details.jobId ?? state.lastJobId;
  state.lastJobStatus = details.jobStatus ?? state.lastJobStatus;
  state.consecutiveFailures += 1;
}
