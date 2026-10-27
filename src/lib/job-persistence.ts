import type { JobKind, JobRecord, JobStartInput } from "./types";
import { isTerminalJob } from "./job-sync";

export const DEFAULT_JOB_RESULT_PERSIST_BYTES = 96 * 1024;

const resumableJobKinds = new Set<JobKind>([
  "account-style",
  "transcribe-video",
  "batch-transcribe",
  "hotlist-refresh",
  "hotspot-refresh",
  "gross-margin-refresh"
]);

export function isResumableJobKind(kind: JobKind, input?: JobStartInput) {
  return resumableJobKinds.has(kind) || (kind === "engagement" && input?.kind === "engagement"
    && Boolean(input.checkpointId) && input.input.includeComments === true && !input.input.includeDanmaku);
}

export function compactJobForPersistence(
  job: JobRecord,
  maxResultBytes = DEFAULT_JOB_RESULT_PERSIST_BYTES
): JobRecord {
  if (!isTerminalJob(job) || typeof job.result === "undefined") return job;
  // These results have no independent persisted asset to read after a restart.
  if (job.kind === "single-video-transcribe" || job.kind === "publish-copy" || job.kind === "image-prompt-assist" ||
    (job.kind === "write-copy" && !hasSavedWriteResult(job.result))) return job;

  const resultSizeBytes = Buffer.byteLength(JSON.stringify(job.result), "utf8");
  if (resultSizeBytes <= maxResultBytes) return job;

  const { result, ...compact } = job;
  void result;
  return {
    ...compact,
    resultCompacted: true,
    resultSizeBytes
  };
}

function hasSavedWriteResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as { draft?: { id?: string }; results?: unknown[] };
  return Boolean(value.draft?.id) || Boolean(value.results?.length && value.results.every(hasSavedWriteResult));
}
