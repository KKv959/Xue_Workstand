import type { JobListItem, JobListResponse, JobRecord } from "./types";

const JOB_LIST_LIMIT = 80;

export function isTerminalJob(job: Pick<JobRecord, "status">) {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "interrupted";
}

export function isActiveJob(job: Pick<JobRecord, "status" | "recoveryError">) {
  return !job.recoveryError && (job.status === "queued" || job.status === "running");
}

export function applyJobListResponse(current: JobListItem[], response: JobListResponse) {
  const removed = new Set(response.removedJobIds);
  const merged = new Map((response.reset ? [] : current).filter((job) => !removed.has(job.id)).map((job) => [job.id, job]));
  for (const job of response.jobs) merged.set(job.id, job);
  return selectJobList([...merged.values()].map(job => response.recoveryErrors ? {
    ...job, recoveryError: isTerminalJob(job) ? undefined : response.recoveryErrors[job.id]
  } : job));
}

export function selectJobList(jobs: JobListItem[]) {
  let recentCount = 0;
  return [...jobs]
    .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt))
    .filter((job) => isActiveJob(job) || recentCount++ < JOB_LIST_LIMIT);
}
