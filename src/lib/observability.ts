import pino, { type Logger } from "pino";
import type { JobRecord } from "./types";

const globalObservability = globalThis as typeof globalThis & {
  __styleWorkbenchLogger?: Logger;
};

const logger = globalObservability.__styleWorkbenchLogger || pino({
  level: process.env.PINO_LOG_LEVEL || "info",
  base: {
    service: "account-style-library"
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "apiKey",
      "token",
      "authorization",
      "headers.authorization",
      "*.apiKey",
      "*.token",
      "*.authorization",
      "*.headers.authorization"
    ],
    censor: "[REDACTED]"
  }
});

globalObservability.__styleWorkbenchLogger = logger;

export function logJobTransition(current: JobRecord, next: JobRecord) {
  const previousEvent = current.events?.at(-1);
  const at = Date.parse(next.updatedAt);
  const previousAt = Date.parse(previousEvent?.at || "");
  const stageDurationMs = Number.isFinite(at) && Number.isFinite(previousAt) && at >= previousAt
    ? at - previousAt
    : undefined;
  const queueWaitMs = current.status === "queued" && next.status === "running"
    ? elapsedMs(current.createdAt, next.updatedAt)
    : undefined;
  const resultSummary = summarizeJobResult(next.result);

  logger.info({
    event: "pipeline.transition",
    jobId: next.id,
    kind: next.kind,
    status: next.status,
    stage: next.stage,
    previousStage: previousEvent?.stage,
    progress: next.progress,
    attempt: next.attempt,
    stageDurationMs,
    queueWaitMs,
    platform: next.scope?.platform,
    targetType: next.scope?.targetType,
    ...resultSummary,
    ...(next.error ? { errorMessage: summarizeError(next.error) } : {})
  }, "pipeline transition");

  if (isTerminal(next.status)) {
    logger.info({
      event: "pipeline.finish",
      jobId: next.id,
      kind: next.kind,
      status: next.status,
      totalMs: elapsedMs(next.createdAt, next.completedAt || next.updatedAt),
      runMs: runDurationMs(next),
      platform: next.scope?.platform,
      targetType: next.scope?.targetType,
      ...resultSummary,
      ...(next.error ? { errorMessage: summarizeError(next.error) } : {})
    }, "pipeline finish");
  }
}

export function logPipelineEvent(event: string, payload: Record<string, unknown> = {}) {
  logger.info({ event, ...compactPayload(payload) }, "pipeline event");
}

function summarizeJobResult(result: unknown) {
  if (!result || typeof result !== "object") return {};
  const record = result as Record<string, unknown>;
  const variants = Array.isArray(record.results)
    ? record.results.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  const contents = [
    ...(typeof record.content === "string" ? [record.content] : []),
    ...variants.flatMap((item) => typeof item.content === "string" ? [item.content] : [])
  ];
  const models = [
    ...(typeof record.usedModel === "string" ? [record.usedModel] : []),
    ...variants.flatMap((item) => typeof item.usedModel === "string" ? [item.usedModel] : [])
  ];
  const fallback = Boolean(
    record.fallback ||
    variants.some((item) => Boolean(item.fallback))
  );
  const cacheHit = Boolean(
    record.cached ||
    record.cacheHit ||
    (typeof record.analysisCachedCount === "number" && record.analysisCachedCount > 0) ||
    (Array.isArray(record.cacheHits) && record.cacheHits.length > 0)
  );
  const inputChars = typeof record.inputChars === "number" ? record.inputChars : undefined;
  const outputChars = contents.length ? contents.reduce((total, content) => total + content.length, 0) : undefined;

  return compactPayload({
    fallback,
    cacheHit,
    usedModels: [...new Set(models)],
    inputChars,
    outputChars,
    variantCount: variants.length || undefined,
    failureCount: Array.isArray(record.failures) ? record.failures.length : undefined
  });
}

function elapsedMs(start: string | undefined, end: string | undefined) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? endMs - startMs
    : undefined;
}

function runDurationMs(job: JobRecord) {
  const firstRunning = job.events?.find((event) => event.status === "running");
  return elapsedMs(firstRunning?.at, job.completedAt || job.updatedAt);
}

function isTerminal(status: JobRecord["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function summarizeError(error: string) {
  return error
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:\/Users\/|[A-Z]:\\)[^\s]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function compactPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
