import { runTrendRadarNative } from "./trendradar-native";
import { trendRadarSettingsSchema } from "./trendradar-native-types";
import { assistImagePrompt } from "./image-prompt-assist";
import { generateImages } from "./image-generation";
import { randomUUID } from "crypto";
import path from "path";
import {
  completeCachedAccountStyle,
  completePreparedAccountStyle,
  completePreparedWriteCopy,
  completePreparedWriteVariant,
  prepareAccountStyleContext,
  prepareWriteCopyBatchContext,
  prepareWriteCopyContext,
  resolveWriteBatchOutcome,
  streamStyleResponseTextWithFallback,
  streamResponseTextWithFallback,
  writeVariantFailure,
  WRITE_COPY_REASONING_EFFORT
} from "./ai";
import { runBatchTranscribe } from "./batch-transcribe";
import { collectAccountContent } from "./account-collection";
import { assertJobKindAllowedForAppMode, isJobKindAllowedForAppMode } from "./app-mode";
import { buildWriterDraftHref } from "./draft-links";
import { generateEngagement } from "./engagement";
import { refreshDouyinHotlist } from "./douyin-hotlist";
import { refreshGrossMarginMonitorRecords } from "./gross-margin-refresh";
import { syncGrossMarginProjectSource } from "./storage/gross-margin-projects";
import { hasSupportDocumentReference } from "./support-documents";
import { extractRewriteSourceMaterial, splitWriterSourceInput } from "./source-extraction";
import { engagementSourceKey, writeCopySourceKey } from "./job-scope";
import { buildEngagementRecordHref, defaultJobHref } from "./job-links";
import { compactJobForPersistence, DEFAULT_JOB_RESULT_PERSIST_BYTES, isResumableJobKind } from "./job-persistence";
import { libraryRoot, resolveDraft } from "./storage";
import { generatePublishCopy } from "./publish-copy";
import { fileExists, readJsonFile, storageFs as fs, writeJsonFile } from "./storage/fs";
import { normalizeStorageSegment } from "./storage/core";
import { parseStoredRecord, STORAGE_SCHEMA_VERSION } from "./storage/schemas";
import { mapWithConcurrency } from "./concurrency";
import { startJobSchema } from "./job-validation";
import { isActiveJob, isTerminalJob, selectJobList } from "./job-sync";
import { transcribeLinkSource, transcribeVideo } from "./transcription";
import {
  BatchTranscribeResult,
  EngagementRecord,
  JobEvent,
  JobKind,
  JobListItem,
  JobRecord,
  JobScope,
  JobStartInput,
  WriteBatchResult,
  WriteGenerationResult
} from "./types";
import { nowIso, shortHash } from "./utils";
import { logJobTransition } from "./observability";

type JobRuntime = {
  initialized: boolean;
  initializing?: Promise<void>;
  active: Map<string, Promise<void>>;
  abortControllers: Map<string, AbortController>;
  cancelRequests: Set<string>;
  pending: Map<string, JobStartInput>;
  records: Map<string, JobRecord>;
  readErrors: Map<string, string>;
  changeEpoch: string;
  changeRevision: number;
  changeLog: Array<{ revision: number; jobId: string; removed?: boolean }>;
};

type PatchJobOptions = {
  persist?: boolean;
  recordSavedData?: boolean;
  beforePatch?: (current: JobRecord) => void;
};

type JobSummaryRead = JobListItem & {
  filePath: string;
};

type JobSummaryCache = {
  fileCount: number;
  mtimeMs: number;
  jobs: JobSummaryRead[];
};

const globalJobs = globalThis as typeof globalThis & {
  __styleWorkbenchJobs?: JobRuntime;
};

const runtime = (() => {
  const existing = globalJobs.__styleWorkbenchJobs;
  if (existing) {
    existing.active ||= new Map();
    existing.abortControllers ||= new Map();
    existing.cancelRequests ||= new Set();
    existing.pending ||= new Map();
    existing.records ||= new Map();
    existing.readErrors ||= new Map();
    existing.changeEpoch ||= "";
    existing.changeRevision ||= 0;
    existing.changeLog ||= [];
    return existing;
  }

  const created: JobRuntime = {
    initialized: false,
    active: new Map(),
    abortControllers: new Map(),
    cancelRequests: new Set(),
    pending: new Map(),
    records: new Map(),
    readErrors: new Map(),
    changeEpoch: "",
    changeRevision: 0,
    changeLog: []
  };
  globalJobs.__styleWorkbenchJobs = created;
  return created;
})();

const jobWriteQueues = new Map<string, Promise<unknown>>();
let jobSummaryCache: JobSummaryCache | null = null;
const PARTIAL_TEXT_PATCH_INTERVAL_MS = 250;
const PARTIAL_TEXT_PATCH_CHARS = 160;
const JOB_SUMMARY_EVENT_LIMIT = 3;
const JOB_CHANGE_LOG_LIMIT = 1200;
const DEFAULT_MAX_ACTIVE_JOBS = 5;
const DEFAULT_JOB_HISTORY_LIMIT = 200;
const DEFAULT_JOB_HISTORY_MAX_BYTES = 20 * 1024 * 1024;
function jobsPath() {
  return path.join(libraryRoot(), "jobs");
}

function jobJsonPath(jobId: string) {
  return path.join(jobsPath(), `${normalizeJobId(jobId)}.json`);
}

function jobPayloadsPath() {
  return path.join(jobsPath(), ".payloads");
}

function jobPayloadPath(jobId: string) {
  return path.join(jobPayloadsPath(), `${normalizeJobId(jobId)}.json`);
}

function normalizeJobId(jobId: string) {
  return normalizeStorageSegment(jobId.trim(), "任务 ID");
}

async function ensureJobs() {
  await Promise.all([
    fs.mkdir(jobsPath(), { recursive: true }),
    fs.mkdir(jobPayloadsPath(), { recursive: true })
  ]);
}

async function readJobRecord(target: string): Promise<JobRecord | null> {
  const raw = await readJsonFile<unknown>(target);
  if (raw === null && !await fileExists(target)) return null;
  const job = parseStoredRecord<JobRecord>(target, raw, "job");
  if (job.id !== path.basename(target, ".json")) throw new Error(`任务记录 ID 与文件名不一致：${target}。请检查素材库。`);
  return job;
}

// One incompatible file must not prevent reading healthy jobs; report every failure to the task center.
async function readJobForList(target: string) {
  try {
    const job = await readJobRecord(target);
    runtime.readErrors.delete(target);
    return job;
  } catch (error) {
    runtime.readErrors.set(target, error instanceof Error ? error.message : `读取任务失败：${target}。请检查素材库。`);
    return null;
  }
}

export function getJobReadErrors() {
  return [...runtime.readErrors.values()];
}

export function getJobRecoveryErrors() {
  return Object.fromEntries([...runtime.readErrors]
    .filter(([target]) => path.dirname(target) === jobPayloadsPath())
    .map(([target, message]) => [path.basename(target, ".json"), message]));
}

async function writeJob(job: JobRecord, options: PatchJobOptions = {}) {
  job = { ...parseStoredRecord<JobRecord>(jobJsonPath(job.id), job, "job"), schemaVersion: STORAGE_SCHEMA_VERSION };
  if (options.persist !== false) {
    const persisted = compactJobForPersistence(job, jobResultPersistBytes());
    await writeJsonFile(jobJsonPath(job.id), persisted);
    invalidateJobSummaryCache();
  }
  runtime.records.set(job.id, job);
  recordJobChange(job.id);
}

async function patchJob(jobId: string, patch: Partial<JobRecord>, options: PatchJobOptions = {}) {
  return enqueueJobWrite(jobId, async () => {
    const current = runtime.records.get(jobId) || await readJobRecord(jobJsonPath(jobId));
    if (!current) throw new Error("找不到任务记录");
    const terminal = isTerminalJob(current);
    if (terminal && !options.recordSavedData) return current;
    options.beforePatch?.(current);
    // A save can finish during cancellation; record its data without reopening the task.
    if (terminal) patch = Object.fromEntries(Object.entries(patch).filter(([key]) => ["result", "resultRef", "dataRevision", "dataChange"].includes(key)));
    const next: JobRecord = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };
    if (shouldRecordJobEvent(current, next, patch)) {
      next.events = appendJobEvent(current.events, {
        at: next.updatedAt,
        status: next.status,
        stage: next.stage,
        message: next.message,
        progress: next.progress
      });
    }
    await writeJob(next, options);
    if (shouldRecordJobEvent(current, next, patch)) {
      logJobTransition(current, next);
    }
    return next;
  });
}

function patchTransientJob(jobId: string, patch: Partial<JobRecord>) {
  return patchJob(jobId, patch, { persist: false });
}

function queueJobPatch(jobId: string, patch: Partial<JobRecord>, transient = false) {
  void (transient ? patchTransientJob(jobId, patch) : patchJob(jobId, patch))
    .catch((error) => reportJobPersistenceError(jobId, error));
}

function patchJobWithDataChange(
  jobId: string,
  patch: Partial<JobRecord>,
  dataChange: Omit<NonNullable<JobRecord["dataChange"]>, "at">
) {
  return patchJob(jobId, patch, {
    recordSavedData: true,
    beforePatch(current) {
      patch.dataRevision = (current.dataRevision || 0) + 1;
      patch.dataChange = { ...dataChange, at: nowIso() };
    }
  });
}

async function enqueueJobWrite<T>(jobId: string, run: () => Promise<T>) {
  const previous = jobWriteQueues.get(jobId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  jobWriteQueues.set(jobId, next);

  try {
    await previous.catch(() => undefined);
    return await run();
  } finally {
    release();
    if (jobWriteQueues.get(jobId) === next) {
      jobWriteQueues.delete(jobId);
    }
  }
}

async function ensureInitialized() {
  if (runtime.initialized) return;
  if (runtime.initializing) return runtime.initializing;

  runtime.initializing = initializeRuntimeJobs().finally(() => {
    runtime.initializing = undefined;
  });
  return runtime.initializing;
}

async function initializeRuntimeJobs() {
  runtime.changeEpoch ||= randomUUID();
  await ensureJobs();
  const resumable = await recoverStaleDiskJobs(await listJobSummariesFromDisk());
  runtime.initialized = true;
  for (const item of resumable) queueBackgroundJob(item.jobId, item.input);
}

async function listJobsFromDisk() {
  await ensureJobs();
  const files = await fs.readdir(jobsPath());
  const jobs = await mapWithConcurrency(files.filter((file) => file.endsWith(".json")), 6, (file) => readJobForList(path.join(jobsPath(), file)));
  return jobs
    .filter((job): job is JobRecord => Boolean(job))
    .filter((job) => isJobKindAllowedForAppMode(job.kind))
    .sort(compareJobsByUpdatedAtDesc);
}

async function listJobSummariesFromDisk() {
  await ensureJobs();
  const files = await fs.readdir(jobsPath());
  const stats = await fs.stat(jobsPath());
  const jsonFileCount = files.filter((file) => file.endsWith(".json")).length;

  if (
    jobSummaryCache &&
    jobSummaryCache.fileCount === jsonFileCount &&
    jobSummaryCache.mtimeMs === stats.mtimeMs
  ) {
    return jobSummaryCache.jobs;
  }

  const targets = new Set(files.filter((file) => file.endsWith(".json")).map((file) => path.join(jobsPath(), file)));
  for (const key of runtime.readErrors.keys()) {
    if (path.dirname(key) === jobsPath() && !targets.has(key)) runtime.readErrors.delete(key);
  }
  const summaries = await mapWithConcurrency([...targets], 6, readJobSummary);
  const jobs = summaries
    .filter((job): job is JobSummaryRead => Boolean(job))
    .filter((job) => isJobKindAllowedForAppMode(job.kind))
    .sort(compareJobsByUpdatedAtDesc);

  jobSummaryCache = {
    fileCount: jsonFileCount,
    mtimeMs: stats.mtimeMs,
    jobs
  };
  return jobs;
}

async function readJobSummary(target: string): Promise<JobSummaryRead | null> {
  const job = await readJobForList(target);
  return job ? { ...toJobListItem(job), filePath: target } : null;
}

async function recoverStaleDiskJobs(jobs: JobSummaryRead[]) {
  const staleJobs = jobs.filter((job) => isActiveJob(job) && !runtime.active.has(job.id) && !runtime.pending.has(job.id));
  if (!staleJobs.length) return [];

  const interruptedAt = nowIso();
  const resumable: Array<{ jobId: string; input: JobStartInput }> = [];
  await Promise.all(
    staleJobs.map(async (summary) => {
      let job: JobRecord | null;
      let input: JobStartInput | null;
      try {
        job = await readJobRecord(summary.filePath);
        if (!job || isTerminalJob(job) || runtime.active.has(job.id)) return;
        input = job.kind === "project-style" || job.kind === "image-cover" ? null : await readJobPayload(job.id, job.kind);
      } catch (error) {
        runtime.readErrors.set(jobPayloadPath(summary.id), `任务 ${summary.id} 未恢复：${error instanceof Error ? error.message : "读取恢复参数失败，请检查素材库。"}`);
        return;
      }
      const removedFeature = job.kind === "project-style" || job.kind === "image-cover";
      const legacyBatch = input?.kind === "batch-transcribe" && !input.input.videoIds &&
        (job.status === "running" || (job.attempt || 0) > 0);
      if (input && isResumableJobKind(job.kind, input) && !legacyBatch) {
        await writeJob({
          ...job,
          status: "queued",
          stage: "queued",
          message: "服务重启后已恢复到队列",
          error: undefined,
          completedAt: undefined,
          resumedAt: interruptedAt,
          updatedAt: interruptedAt
        });
        resumable.push({ jobId: job.id, input });
        return;
      }
      await writeJob({
        ...job,
        status: "interrupted",
        progress: job.progress || 0,
        message: removedFeature ? "该功能已移除，历史任务已中断，已保存资料仍保留。" : legacyBatch ? "旧版批量任务缺少固定候选，已中断，请确认范围后重新发起。" : input ? "服务重启后任务已中断，可从任务中心重试。" : "服务重启后任务已中断，且缺少恢复参数。",
        error: removedFeature ? "项目写作与草稿封面功能已移除，无法继续此任务。" : legacyBatch ? "缺少原批次候选，无法安全自动恢复。" : input ? "任务已中断，可重试。" : "任务恢复参数缺失，请重新发起。",
        updatedAt: interruptedAt,
        completedAt: interruptedAt
      });
    })
  );
  return resumable;
}

function stripSummaryFilePath({ filePath, ...job }: JobSummaryRead): JobListItem {
  void filePath;
  return withJobRecoveryError(job);
}

export async function listJobs() {
  await ensureInitialized();
  const jobs = new Map((await listJobsFromDisk()).map((job) => [job.id, job]));
  for (const job of runtime.records.values()) {
    if (isJobKindAllowedForAppMode(job.kind)) jobs.set(job.id, job);
  }
  return [...jobs.values()].map(withJobRecoveryError).sort(compareJobsByUpdatedAtDesc);
}

export function isJobExecuting(jobId: string) {
  return runtime.abortControllers.has(jobId) || runtime.pending.has(jobId);
}

export async function listJobSummaries(options: { all?: boolean } = {}) {
  await ensureInitialized();
  const summaries = new Map(
    (await listJobSummariesFromDisk()).map((job) => [job.id, stripSummaryFilePath(job)])
  );
  for (const job of runtime.records.values()) {
    if (isJobKindAllowedForAppMode(job.kind)) summaries.set(job.id, toJobListItem(job));
  }
  const sorted = [...summaries.values()].sort(compareJobsByUpdatedAtDesc);
  return options.all ? sorted : selectJobList(sorted);
}

export async function listJobSummaryChanges(cursor?: string) {
  await ensureInitialized();
  const currentCursor = jobChangeCursor();
  const parsed = parseJobChangeCursor(cursor);
  const firstRevision = runtime.changeLog[0]?.revision ?? runtime.changeRevision + 1;
  const reset = !parsed
    || parsed.epoch !== runtime.changeEpoch
    || parsed.revision > runtime.changeRevision
    || parsed.revision < firstRevision - 1;

  if (reset) {
    return {
      jobs: await listJobSummaries(),
      removedJobIds: [],
      cursor: currentCursor,
      reset: true
    };
  }

  const changes = runtime.changeLog.filter((change) => change.revision > parsed.revision);
  if (!changes.length) {
    return { jobs: [], removedJobIds: [], cursor: currentCursor, reset: false };
  }
  const latestById = new Map<string, { revision: number; removed?: boolean }>();
  for (const change of changes) latestById.set(change.jobId, change);
  const current = new Map((await listJobSummaries()).map((job) => [job.id, job]));
  return {
    jobs: [...latestById.entries()]
      .filter(([, change]) => !change.removed)
      .map(([jobId]) => current.get(jobId))
      .filter((job): job is JobListItem => Boolean(job)),
    removedJobIds: [...latestById.entries()]
      .filter(([jobId, change]) => change.removed || !current.has(jobId))
      .map(([jobId]) => jobId),
    cursor: currentCursor,
    reset: false
  };
}

export async function getJob(jobId: string) {
  await ensureInitialized();
  const cached = runtime.records.get(jobId);
  if (cached) {
    assertJobKindAllowedForAppMode(cached.kind);
    return withJobRecoveryError(cached);
  }

  const job = await readJobRecord(jobJsonPath(jobId));
  if (!job) throw new Error("找不到任务记录");
  assertJobKindAllowedForAppMode(job.kind);
  runtime.records.set(job.id, job);
  return withJobRecoveryError(job);
}

export async function createJob(input: JobStartInput) {
  input = startJobSchema.parse(input);
  assertJobKindAllowedForAppMode(input.kind);
  await ensureInitialized();
  if (input.kind === "engagement") input = { ...input, checkpointId: input.checkpointId || randomUUID() };
  const now = nowIso();
  const job: JobRecord = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    id: makeJobId(input.kind),
    kind: input.kind,
    status: "queued",
    title: input.title || defaultJobTitle(input),
    inputSummary: input.inputSummary || defaultInputSummary(input),
    scope: defaultJobScope(input),
    stage: "queued",
    message: "任务已加入队列",
    progress: 0,
    href: input.href || defaultJobHref(input.kind),
    events: [
      {
        at: now,
        status: "queued",
        stage: "queued",
        message: "任务已加入队列",
        progress: 0
      }
    ],
    createdAt: now,
    updatedAt: now
  };

  await writeJobPayload(job.id, input);
  try {
    await writeJob(job);
  } catch (error) {
    await removeJobPayload(job.id);
    throw error;
  }
  queueBackgroundJob(job.id, input);
  return job;
}

function queueBackgroundJob(jobId: string, input: JobStartInput) {
  if (runtime.active.has(jobId) || runtime.pending.has(jobId)) return;
  runtime.pending.set(jobId, input);
  pumpJobQueue();
}

function pumpJobQueue() {
  while (runtime.active.size < maxActiveJobs()) {
    const next = runtime.pending.entries().next();
    if (next.done) return;

    const [jobId, input] = next.value;
    runtime.pending.delete(jobId);
    if (runtime.cancelRequests.has(jobId)) continue;

    const promise = runJob(jobId, input).catch((error) => reportJobPersistenceError(jobId, error)).finally(() => {
      runtime.active.delete(jobId);
      pumpJobQueue();
    });
    runtime.active.set(jobId, promise);
  }
}

async function runJob(jobId: string, input: JobStartInput) {
  const controller = new AbortController();
  runtime.abortControllers.set(jobId, controller);
  try {
    throwIfCancelled(jobId);
    const current = await getJob(jobId);
    await patchJob(jobId, {
      status: "running",
      stage: "start",
      message: "任务正在运行",
      progress: 3,
      attempt: (current.attempt || 0) + 1
    });

    if (input.kind === "image-prompt-assist") {
      await patchJob(jobId, { message: "正在优化图片提示词", progress: 20 });
      const result = await assistImagePrompt(input.input, getJobAbortSignal(jobId));
      throwIfCancelled(jobId);
      await completeJob(jobId, { message: "提示词建议已生成", result, resultRef: { id: jobId, href: `/images?assistId=${encodeURIComponent(jobId)}`, label: "查看建议" } });
    } else if (input.kind === "image-generation") {
      await runImageGenerationJob(jobId, input);
    } else if (input.kind === "write-copy") {
      await runWriteCopyJob(jobId, input);
    } else if (input.kind === "account-style") {
      await runAccountStyleJob(jobId, input);
    } else if (input.kind === "transcribe-video") {
      await runTranscribeVideoJob(jobId, input);
    } else if (input.kind === "batch-transcribe") {
      await runBatchTranscribeJob(jobId, input);
    } else if (input.kind === "hotlist-refresh") {
      await runHotlistRefreshJob(jobId, input);
    } else if (input.kind === "collect-account") {
      await runCollectAccountJob(jobId, input);
    } else if (input.kind === "single-video-transcribe") {
      await runSingleVideoTranscribeJob(jobId, input);
    } else if (input.kind === "publish-copy") {
      await runPublishCopyJob(jobId, input);
    } else if (input.kind === "hotspot-refresh") {
      await runHotspotRefreshJob(jobId, input);
    } else if (input.kind === "gross-margin-refresh") {
      await runGrossMarginRefreshJob(jobId, input);
    } else {
      await runEngagementJob(jobId, input);
    }
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error && !(controller.signal.reason instanceof CancelledJobError) && !runtime.cancelRequests.has(jobId)) {
      error = controller.signal.reason;
    }
    const cancelled = runtime.cancelRequests.has(jobId) || controller.signal.reason instanceof CancelledJobError ||
      (!controller.signal.aborted && isCancelledJobError(error));
    if (cancelled) {
      const current = runtime.records.get(jobId) || await readJobRecord(jobJsonPath(jobId));
      await patchJob(jobId, {
        status: "cancelled",
        stage: "cancelled",
        message: current?.message || "任务已停止",
        error: undefined,
        progress: current?.progress || 0,
        completedAt: nowIso()
      });
      return;
    }
    await patchJob(jobId, {
      status: "failed",
      progress: 100,
      stage: "failed",
      message: "任务失败",
      error: error instanceof Error ? error.message : "任务失败，请稍后重试。",
      completedAt: nowIso()
    });
    await pruneJobHistory();
  } finally {
    runtime.abortControllers.delete(jobId);
    runtime.cancelRequests.delete(jobId);
  }
}

async function runImageGenerationJob(jobId: string, start: Extract<JobStartInput, { kind: "image-generation" }>) {
  const href = `/images?recordId=${encodeURIComponent(jobId)}`;
  await patchJob(jobId, { href, resultRef: { id: jobId, href, label: "查看图片" } });
  const result = await generateImages(jobId, start.input, {
    signal: getJobAbortSignal(jobId),
    onProgress: async (message, progress, saved) => {
      const patch = { message, progress, stage: saved ? "save" : "generate" };
      if (saved) await patchJobWithDataChange(jobId, patch, { resource: "image-generation", recordId: jobId });
      else await patchJob(jobId, patch);
    }
  });
  throwIfCancelled(jobId);
  await completeJob(jobId, { message: `已生成 ${result.images.length} 张图片`, result: { recordId: result.id }, resultRef: { id: jobId, href, label: "查看图片" } });
}

async function runWriteCopyJob(jobId: string, start: Extract<JobStartInput, { kind: "write-copy" }>) {
  throwIfCancelled(jobId);
  const isRevision = start.input.action === "revise";
  const separatedSourceInput = splitWriterSourceInput(start.input.sourceText || "", start.input.supportDocLinks || "");
  const sourceExtraction = extractRewriteSourceMaterial(separatedSourceInput.sourceText);
  await patchJob(jobId, {
    stage: "prepare",
    message: isRevision ? "正在读取当前稿件和版本上下文" : "正在读取风格卡和共享资料",
    progress: 10
  });

  if (!isRevision && start.input.mode === "rewrite" && sourceExtraction.pendingLinkCount > 0) {
    await patchJob(jobId, {
      stage: "transcribe-links",
      message: "正在转写链接里的视频文稿",
      progress: 18
    });
  }

  if (!isRevision && hasSupportDocumentReference(separatedSourceInput.supportDocLinks)) {
    await patchJob(jobId, {
      stage: "fetch-support-docs",
      message: "正在准备商单支持文档（已读内容会自动复用）",
      progress: 24
    });
  }

  if (isRevision) {
    if (start.input.revisionTargets?.length) {
      await runWriteBatchRevisionJob(jobId, start);
      return;
    }
    await runWriteRevisionJob(jobId, start);
    return;
  }

  const batch = await prepareWriteCopyBatchContext(start.input, {
    signal: getJobAbortSignal(jobId),
    onProgress(message) { queueJobPatch(jobId, { stage: "prepare-style", message, progress: 32 }); }
  });
  throwIfCancelled(jobId);

  if (start.input.useWebResearch) {
    await patchJob(jobId, {
      stage: "research",
      message: "联网检索已完成，正在整理资料",
      progress: 35,
      result: batch.research ? { research: batch.research } : undefined
    });
  }

  const variantCount = batch.variants.length;
  await patchJob(jobId, {
    stage: "generate",
    message: variantCount > 1 ? `正在并发生成 ${variantCount} 篇独立文案` : "正在生成文案",
    progress: 55
  });

  let partialText = "";
  const partialUpdater = createPartialTextUpdater(jobId, {
    stage: "generate", message: "正在生成正文", progress: text => Math.min(86, 55 + Math.floor(text.length / 120))
  });
  let completedCount = 0;
  const partialResult: WriteBatchResult = { kind: "write-batch", results: [], failures: [...(batch.preparationFailures || [])], research: batch.research, sourceDigest: batch.sourceDigest };
  const outcomes = await Promise.all(batch.variants.map(async (variant) => {
    try {
      const result = await streamResponseTextWithFallback({
        policy: "writer_generate",
        messages: variant.prepared.messages,
        reasoningEffort: WRITE_COPY_REASONING_EFFORT,
        signal: getJobAbortSignal(jobId),
        async onRetry(message) {
          await patchTransientJob(jobId, { stage: "generate", message: `${variant.styleTitle}：${message}` });
        },
        onDelta(delta) {
          if (variantCount === 1) {
            partialText += delta;
            partialUpdater.update(partialText);
          }
        }
      });
      if (variantCount === 1) await partialUpdater.flush(partialText);
      const completed = await completePreparedWriteVariant({
        variant,
        result,
        save: start.input.save,
        signal: getJobAbortSignal(jobId)
      });
      if (completed.draft) {
        partialResult.results.push(completed);
        const result = { ...partialResult, results: [...partialResult.results], failures: [...partialResult.failures] };
        await patchJobWithDataChange(jobId, { result, resultRef: writeResultRef(result) }, { resource: "drafts" });
      }
      completedCount += 1;
      await patchTransientJob(jobId, {
        stage: "generate",
        message: variantCount > 1
          ? `已完成 ${completedCount}/${variantCount} 篇，其他风格仍在生成`
          : "正在整理生成结果",
        progress: Math.min(91, 55 + Math.floor((completedCount / variantCount) * 34))
      });
      return { result: completed };
    } catch (error) {
      if (isCancelledJobError(error, getJobAbortSignal(jobId))) throw error;
      partialResult.failures.push(writeVariantFailure(variant, error));
      completedCount += 1;
      await patchTransientJob(jobId, {
        stage: "generate",
        message: `已处理 ${completedCount}/${variantCount} 篇，正在等待其余结果`,
        progress: Math.min(91, 55 + Math.floor((completedCount / variantCount) * 34))
      });
      return { failure: writeVariantFailure(variant, error) };
    }
  }));
  throwIfCancelled(jobId);

  if (start.input.save) {
    await patchJob(jobId, {
      stage: "save-draft",
      message: "正在整理已保存的独立草稿",
      progress: 92
    });
  }

  const finalResult = resolveWriteBatchOutcome(batch, outcomes);
  const isBatchResult = "kind" in finalResult && finalResult.kind === "write-batch";
  const successfulCount = isBatchResult ? finalResult.results.length : 1;
  const failedCount = isBatchResult ? finalResult.failures.length : 0;
  await completeJob(jobId, {
    message: failedCount
      ? `已生成 ${successfulCount} 篇，${failedCount} 篇失败`
      : successfulCount > 1 ? `${successfulCount} 篇独立文案已生成` : "文案生成完成",
    result: finalResult,
    partialText: firstWriteResultContent(finalResult),
    resultRef: writeResultRef(finalResult)
  });
}

async function runWriteBatchRevisionJob(jobId: string, start: Extract<JobStartInput, { kind: "write-copy" }>) {
  const targets = start.input.revisionTargets || [];
  const batch: WriteBatchResult = { kind: "write-batch", results: [], failures: [] };
  for (const [index, target] of targets.entries()) {
    throwIfCancelled(jobId);
    const { draft } = await resolveDraft(target.parentDraftId);
    const styleReference = draft.targetType === "project"
      ? { targetType: "project" as const, projectId: draft.projectId, projectName: draft.projectName }
      : { targetType: "account" as const, platform: draft.platform, accountId: draft.accountId, accountName: draft.accountName };
    const styleTitle = draft.targetType === "project" ? draft.projectName : draft.accountName;
    await patchJob(jobId, { stage: "generate", message: `正在修改 ${index + 1}/${targets.length} · ${styleTitle}`, progress: 10 + Math.floor(index / targets.length * 80) });
    try {
      const prepared = await prepareWriteCopyContext({ ...start.input, ...target, revisionScope: "full", selectedText: undefined }, { signal: getJobAbortSignal(jobId) });
      const result = await streamResponseTextWithFallback({ policy: "writer_revise", messages: prepared.messages,
        reasoningEffort: WRITE_COPY_REASONING_EFFORT, signal: getJobAbortSignal(jobId), onDelta() {},
        async onRetry(message) { await patchTransientJob(jobId, { stage: "generate", message: `${styleTitle}：${message}` }); } });
      throwIfCancelled(jobId);
      const completed = await completePreparedWriteCopy({ prepared, result, save: true, signal: getJobAbortSignal(jobId) });
      batch.results.push({ ...completed, styleKey: target.parentDraftId, styleTitle, styleReference });
      await patchJobWithDataChange(jobId, { result: { ...batch }, message: `已保存 ${batch.results.length}/${targets.length} 篇新版本` }, { resource: "drafts" });
    } catch (error) {
      if (isCancelledJobError(error, getJobAbortSignal(jobId))) throw error;
      batch.failures.push({ styleKey: target.parentDraftId, styleTitle, styleReference, error: error instanceof Error ? error.message : "修改失败" });
    }
  }
  if (!batch.results.length) throw new Error(batch.failures.map(item => `${item.styleTitle}：${item.error}`).join("；") || "没有可修改的稿件");
  await completeJob(jobId, { result: batch, message: `已修改 ${batch.results.length} 篇${batch.failures.length ? `，${batch.failures.length} 篇失败` : ""}`, resultRef: writeResultRef(batch) });
}

async function runWriteRevisionJob(jobId: string, start: Extract<JobStartInput, { kind: "write-copy" }>) {
  let partialText = "";
  const partialUpdater = createPartialTextUpdater(jobId, {
    stage: "generate",
    message: "正在生成新版本",
    progress(text) {
      return Math.min(86, 60 + Math.floor(text.length / 120));
    }
  });
  const prepared = await prepareWriteCopyContext(start.input, { signal: getJobAbortSignal(jobId) });
  throwIfCancelled(jobId);
  await patchJob(jobId, {
    stage: "generate",
    message: "正在按本轮要求生成新版本",
    progress: 55
  });
  const result = await streamResponseTextWithFallback({
    policy: "writer_revise",
    messages: prepared.messages,
    reasoningEffort: WRITE_COPY_REASONING_EFFORT,
    signal: getJobAbortSignal(jobId),
    async onRetry(message) { await patchTransientJob(jobId, { stage: "generate", message }); },
    onDelta(delta) {
      partialText += delta;
      partialUpdater.update(partialText);
    }
  });
  await partialUpdater.flush(partialText);
  throwIfCancelled(jobId);
  if (start.input.save) {
    await patchJob(jobId, {
      stage: "save-draft",
      message: "正在保存历史记录",
      progress: 88
    });
  }
  const finalResult = await completePreparedWriteCopy({
    prepared,
    result,
    save: start.input.save,
    signal: getJobAbortSignal(jobId)
  });
  if (finalResult.draft) {
    await patchJobWithDataChange(jobId, { result: finalResult, resultRef: writeResultRef(finalResult) }, { resource: "drafts" });
  }
  throwIfCancelled(jobId);
  await completeJob(jobId, {
    message: "文案新版本已生成",
    result: finalResult,
    partialText: finalResult.content,
    resultRef: writeResultRef(finalResult)
  });
}

async function runAccountStyleJob(jobId: string, start: Extract<JobStartInput, { kind: "account-style" }>) {
  throwIfCancelled(jobId);
  const startedAt = Date.now();
  let partialText = "";
  let firstDeltaMs: number | undefined;
  const partialUpdater = createPartialTextUpdater(jobId, {
    stage: "generate",
    message: "正在生成账号风格卡",
    progress(text) {
      return Math.min(88, 45 + Math.floor(text.length / 90));
    }
  });
  await patchJob(jobId, {
    stage: "prepare",
    message: "正在读取账号转写样本",
    progress: 12
  });
  const context = await prepareAccountStyleContext(start.input.platform, start.input.accountId, {
    force: start.input.force,
    signal: getJobAbortSignal(jobId),
    onAnalysisProgress(progress) {
      const percent = progress.analysisCount
        ? Math.floor((progress.completedCount / progress.analysisCount) * 25)
        : 0;
      queueJobPatch(jobId, {
        stage: "analysis",
        message: progress.message || `正在分析完整样本 ${progress.completedCount}/${progress.analysisCount}`,
        progress: Math.min(34, 12 + percent)
      });
    }
  });
  throwIfCancelled(jobId);
  const cached = completeCachedAccountStyle(context);
  if (cached) {
    const cachedResult = { ...cached, totalMs: Date.now() - startedAt };
    await patchJob(jobId, {
      stage: "cache",
      message: "样本未变化，已复用现有风格卡",
      progress: 95,
      partialText: cachedResult.style
    });
    await completeJob(jobId, {
      message: "账号风格卡已复用",
      result: cachedResult,
      partialText: cachedResult.style,
      resultRef: {
        id: start.input.accountId,
        href: start.href || "/library",
        label: "查看账号库"
      }
    });
    return;
  }

  await patchJob(jobId, {
    stage: "generate",
    message: context.generationMode === "incremental" ? "正在增量更新账号风格卡" : "正在生成账号风格卡",
    progress: 35
  });
  const result = await streamStyleResponseTextWithFallback({
    messages: context.messages,
    signal: getJobAbortSignal(jobId),
    onDelta(delta) {
      if (firstDeltaMs === undefined) firstDeltaMs = Date.now() - startedAt;
      partialText += delta;
      partialUpdater.update(partialText);
    }
  });
  if (!partialText.trim() && result.text) {
    if (firstDeltaMs === undefined) firstDeltaMs = Date.now() - startedAt;
    partialText = result.text;
  }
  await partialUpdater.flush(partialText);
  throwIfCancelled(jobId);

  await patchJob(jobId, {
    stage: "save",
    message: "正在写入账号风格卡",
    progress: 90
  });
  const saved = await completePreparedAccountStyle(context, result, {
    firstDeltaMs,
    totalMs: Date.now() - startedAt
  });
  throwIfCancelled(jobId);
  await completeJob(jobId, {
    message: "账号风格卡已生成",
    result: saved,
    partialText: saved.style,
    resultRef: {
      id: start.input.accountId,
      href: start.href || "/library",
      label: "查看账号库"
    }
  });
}

async function runTranscribeVideoJob(jobId: string, start: Extract<JobStartInput, { kind: "transcribe-video" }>) {
  throwIfCancelled(jobId);
  await patchJob(jobId, {
    stage: "prepare",
    message: "正在检查字幕和媒体",
    progress: 12
  });

  await patchJob(jobId, {
    stage: "transcribe",
    message: "正在转写视频",
    progress: 35
  });
  const result = await transcribeVideo({
    ...start.input,
    signal: getJobAbortSignal(jobId)
  });
  throwIfCancelled(jobId);

  await patchJob(jobId, {
    stage: "save",
    message: "正在保存转写结果",
    progress: 88
  });

  await completeJob(jobId, {
    message: "转写稿已生成",
    result,
    resultRef: {
      id: start.input.videoId,
      href: start.href || "/library",
      label: "查看账号库"
    }
  });
}

async function runBatchTranscribeJob(jobId: string, start: Extract<JobStartInput, { kind: "batch-transcribe" }>) {
  throwIfCancelled(jobId);
  const result = await runBatchTranscribe(start.input, {
    signal: getJobAbortSignal(jobId),
    async onCandidates(videoIds) {
      if (!start.input.videoIds) {
        await writeJobPayload(jobId, { ...start, input: { ...start.input, videoIds } });
      }
    },
    onPrepare() {
      throwIfCancelled(jobId);
      queueJobPatch(jobId, {
        stage: "prepare",
        message: "正在读取账号和候选视频",
        progress: 8
      }, true);
    },
    onMediaPreloadStart({ total }) {
      throwIfCancelled(jobId);
      queueJobPatch(jobId, {
        stage: "media-preload",
        message: `正在预取 ${total} 条抖音视频的媒体地址`,
        progress: 12
      }, true);
    },
    onVideoStart({ index, total, video }) {
      throwIfCancelled(jobId);
      const progress = total ? 18 + Math.round((index / total) * 64) : 70;
      queueJobPatch(jobId, {
        stage: "transcribe",
        message: `正在处理第 ${index + 1}/${total} 条视频：${video.title}`,
        progress
      }, true);
    },
    async onVideoResult(video) {
      await patchJobWithDataChange(jobId, {
        message: `已处理：${video.title}`,
        result: { latestVideo: video }
      }, { resource: "library-account", accountId: start.input.accountId, videoId: video.videoId });
    },
    async onTranscribeComplete({ completed, skipped, failed }) {
      throwIfCancelled(jobId);
      await patchJobWithDataChange(jobId, {
        stage: "transcripts-saved",
        message: `转写已同步：新增 ${completed}，跳过 ${skipped}，失败 ${failed}`,
        progress: 86
      }, {
        resource: "library-account",
        accountId: start.input.accountId
      });
    },
    onStyleStart() {
      throwIfCancelled(jobId);
      queueJobPatch(jobId, {
        stage: "style",
        message: "正在更新账号风格卡",
        progress: 88
      }, true);
    },
    onFinalize() {
      throwIfCancelled(jobId);
      queueJobPatch(jobId, {
        stage: "finalize",
        message: "正在整理转写结果",
        progress: 98
      }, true);
    }
  });
  throwIfCancelled(jobId);

  await completeJob(jobId, {
    message: summarizeBatchResult(result),
    result,
    resultRef: {
      id: start.input.accountId,
      href: start.href || "/library",
      label: "查看账号库"
    }
  });
}

async function runEngagementJob(jobId: string, start: Extract<JobStartInput, { kind: "engagement" }>) {
  throwIfCancelled(jobId);
  await patchJob(jobId, {
    stage: "prepare",
    message: start.input.sourceType === "url" ? "正在读取链接并准备素材" : "正在准备互动素材",
    progress: 18
  });
  const result = await generateEngagement(start.input, {
    checkpointId: start.checkpointId,
    signal: getJobAbortSignal(jobId),
    async onProgress(progress) {
      throwIfCancelled(jobId);
      const patch = {
        stage: progress.stage,
        message: progress.message,
        progress: progress.progress,
        ...(progress.previewComments !== undefined ? {
          result: {
            previewComments: progress.previewComments,
            requestedCount: start.input.commentCount
          }
        } : {})
      };
      if (progress.checkpointSaved) await patchJobWithDataChange(jobId, patch, { resource: "engagement" });
      else await patchTransientJob(jobId, patch);
    }
  });
  throwIfCancelled(jobId);

  await completeJob(jobId, {
    message: buildEngagementSuccessMessage(result.record),
    result,
    resultRef: {
      id: result.record.id,
      href: buildEngagementRecordHref(
        result.record.id,
        start.input.sourceType === "draft" ? `/assets?draftId=${encodeURIComponent(start.input.draftId)}` : "/assets"
      ),
      label: "查看评论生成"
    }
  });
}

async function runHotlistRefreshJob(jobId: string, start: Extract<JobStartInput, { kind: "hotlist-refresh" }>) {
  throwIfCancelled(jobId);
  await patchJob(jobId, {
    stage: "prepare",
    message: "正在读取热榜账号池",
    progress: 8
  });

  const result = await refreshDouyinHotlist({
    accountIds: start.input.accountIds,
    limit: start.input.limit,
    windowKey: start.input.window,
    signal: getJobAbortSignal(jobId),
    async onProgress(progress) {
      throwIfCancelled(jobId);
      const account = progress.result;
      const status = account.status === "completed" ? "有更新" : account.status === "unchanged" ? "无变化" : "失败";
      await patchJobWithDataChange(jobId, {
        stage: "collect",
        message: `已处理 ${progress.completed}/${progress.total}：${account.name}（${status}）`,
        progress: Math.min(92, 10 + Math.round((progress.completed / progress.total) * 82))
      }, {
        resource: "douyin-hotlist",
        accountId: account.accountId
      });
    }
  });
  throwIfCancelled(jobId);

  if (result.refresh.requested > 0 && result.refresh.failed === result.refresh.requested) {
    const details = result.refresh.accounts
      .map((account) => account.error)
      .filter(Boolean)
      .slice(0, 3)
      .join("；");
    throw new Error(details ? `视频热榜刷新失败：${details}` : "视频热榜刷新失败：所有账号都未返回可用结果。");
  }

  await completeJob(jobId, {
    message: `热榜刷新完成：${result.refresh.completed} 个账号有更新，${result.refresh.unchanged} 个无变化，${result.refresh.failed} 个失败`,
    result: {
      automatic: Boolean(start.input.automatic),
      refresh: result.refresh,
      summary: result.summary
    },
    resultRef: {
      href: start.href || "/douyin-hotlist",
      label: "查看视频热榜"
    }
  });
}

async function runCollectAccountJob(jobId: string, start: Extract<JobStartInput, { kind: "collect-account" }>) {
  const result = await collectAccountContent(start.input, {
    signal: getJobAbortSignal(jobId),
    async onProgress(progress) {
      throwIfCancelled(jobId);
      await patchTransientJob(jobId, progress);
    }
  });
  throwIfCancelled(jobId);
  await completeJob(jobId, {
    message: `账号采集完成：写入 ${result.filteredCount} 条视频到「${result.account.name}」${result.videos.some((video) => video.statsHydration?.status === "failed")
      ? `；${result.videos.filter((video) => video.statsHydration?.status === "failed").length} 条视频详情补全失败，请在账号库重试补全`
      : ""}`,
    result,
    resultRef: {
      id: result.account.id,
      href: start.href || "/library",
      label: "查看账号库"
    }
  });
}

async function runSingleVideoTranscribeJob(jobId: string, start: Extract<JobStartInput, { kind: "single-video-transcribe" }>) {
  await patchJob(jobId, {
    stage: "resolve-link",
    message: "正在识别视频并读取字幕",
    progress: 18
  });
  const result = await transcribeLinkSource({
    ...start.input,
    analyzeVideo: true,
    signal: getJobAbortSignal(jobId)
  });
  throwIfCancelled(jobId);
  await completeJob(jobId, {
    message: result.fallback ? result.fallbackReason || "已提取可用文本" : "视频文案已提取",
    result,
    resultRef: { href: start.href || "/tools", label: "查看工具台" }
  });
}

async function runPublishCopyJob(jobId: string, start: Extract<JobStartInput, { kind: "publish-copy" }>) {
  await patchJob(jobId, {
    stage: "research",
    message: "正在规划检索词并收集同类选题",
    progress: 22
  });
  const result = await generatePublishCopy(start.input, { signal: getJobAbortSignal(jobId) });
  throwIfCancelled(jobId);
  await completeJob(jobId, {
    message: `已生成 ${result.candidates.length} 组标题和发布文案`,
    result,
    resultRef: { href: start.href || "/tools", label: "查看工具台" }
  });
}

async function runHotspotRefreshJob(jobId: string, start: Extract<JobStartInput, { kind: "hotspot-refresh" }>) {
  if (start.input.retryReport || start.input.continueAnalysis || start.input.trendRadarIds) {
    throw new Error("热点雷达已切换为 TrendRadar 原生报告，请回到热点雷达重新生成报告，旧选题批次不能续跑");
  }
  const result = await runTrendRadarNative(start.input.native || trendRadarSettingsSchema.parse({}), {
    signal: getJobAbortSignal(jobId),
    onProgress: progress => patchTransientJob(jobId, progress).then(() => undefined),
  });
  await patchJobWithDataChange(jobId, { stage: "saved", progress: 98, message: "TrendRadar 原生报告已保存" }, { resource: "hotspots" });
  throwIfCancelled(jobId);
  await completeJob(jobId, {
    message: `TrendRadar 报告完成：分析 ${result.counts.analyzed} 条资讯${result.warnings.length ? `，${result.warnings.length} 项来源或分析提示` : ""}`,
    result, resultRef: { href: "/hotspots?view=topics", label: "查看 TrendRadar 报告" }
  });
}

async function runGrossMarginRefreshJob(jobId: string, start: Extract<JobStartInput, { kind: "gross-margin-refresh" }>) {
  if (start.input.syncProjects) {
    await patchJob(jobId, { stage: "load", message: "正在读取企业微信当月项目报价", progress: 8 });
    const source = await syncGrossMarginProjectSource({
      signal: getJobAbortSignal(jobId),
      onProgress: async attempt => {
        throwIfCancelled(jobId);
        await patchTransientJob(jobId, { stage: "load", message: "企业微信正在导出项目表，可在任务中心停止或重试", progress: Math.min(90, 10 + attempt) });
      }
    });
    await patchJobWithDataChange(jobId, { stage: "saved", message: "当月项目报价已同步", progress: 98 }, { resource: "gross-margin" });
    throwIfCancelled(jobId);
    await completeJob(jobId, { message: `${source.month} 项目报价已同步：${source.orders.length} 条`, result: { month: source.month, projectOrderCount: source.orders.length }, resultRef: { href: "/gross-margin", label: "查看项目报价" } });
    return;
  }
  await patchJob(jobId, {
    stage: "load",
    message: "正在读取监控记录",
    progress: 8
  });
  const records = await refreshGrossMarginMonitorRecords(start.input.recordIds, {
    signal: getJobAbortSignal(jobId),
    async onProgress(progress) {
      throwIfCancelled(jobId);
      await patchJobWithDataChange(jobId, {
        stage: "refresh",
        message: `已刷新 ${progress.completed}/${progress.total}：${progress.record.accountName || progress.record.title || progress.record.id}`,
        progress: Math.min(94, 10 + Math.round((progress.completed / Math.max(1, progress.total)) * 84))
      }, {
        resource: "gross-margin",
        recordId: progress.record.id
      });
    }
  });
  throwIfCancelled(jobId);
  const failed = records.filter((record) => record.status === "failed").length;
  await completeJob(jobId, {
    message: `监控刷新完成：${records.length - failed} 条成功，${failed} 条失败`,
    result: { records },
    resultRef: { href: start.href || "/gross-margin/monitor", label: "查看数据监控" }
  });
}

export async function cancelJob(jobId: string) {
  await ensureInitialized();
  const current = await getJob(jobId);

  if (current.status === "completed" || current.status === "failed" || current.status === "cancelled" || current.status === "interrupted") {
    throw new Error("任务已结束，无法停止");
  }

  runtime.cancelRequests.add(jobId);
  runtime.pending.delete(jobId);
  runtime.abortControllers.get(jobId)?.abort();

  const next = await patchJob(jobId, {
    status: "cancelled",
    stage: "cancelled",
    message: "任务已停止",
    error: undefined,
    completedAt: nowIso()
  });
  if (current.kind !== "engagement") await removeJobPayload(jobId);
  await pruneJobHistory();
  pumpJobQueue();
  return next;
}

export async function retryJob(jobId: string) {
  await ensureInitialized();
  const current = await getJob(jobId);
  if (current.recoveryError) throw new Error(current.recoveryError);
  if (!isTerminalJob(current)) throw new Error("任务仍在运行，无法重试");
  const input = await readJobPayload(jobId, current.kind);
  if (!input) throw new Error("任务恢复参数缺失，请重新发起。");
  return createJob(input);
}

async function completeJob(
  jobId: string,
  patch: Pick<JobRecord, "message"> & Partial<Pick<JobRecord, "result" | "resultRef" | "partialText">>
) {
  await patchJob(jobId, {
    ...patch,
    status: "completed",
    stage: "done",
    progress: 100,
    completedAt: nowIso()
  }, {
    beforePatch() {
      throwIfCancelled(jobId);
    }
  });
  await removeJobPayload(jobId);
  await pruneJobHistory();
}

function createPartialTextUpdater(
  jobId: string,
  options: {
    stage: string;
    message: string;
    progress: (text: string) => number;
  }
) {
  let lastPatchedAt = 0;
  let lastPatchedLength = 0;

  const shouldPatch = (text: string) => {
    const now = Date.now();
    return (
      !lastPatchedAt ||
      now - lastPatchedAt >= PARTIAL_TEXT_PATCH_INTERVAL_MS ||
      text.length - lastPatchedLength >= PARTIAL_TEXT_PATCH_CHARS
    );
  };

  const patch = (text: string) => {
    lastPatchedAt = Date.now();
    lastPatchedLength = text.length;
    return patchTransientJob(jobId, {
      stage: options.stage,
      message: options.message,
      progress: options.progress(text),
      partialText: text
    });
  };

  return {
    update(text: string) {
      if (shouldPatch(text)) void patch(text).catch((error) => reportJobPersistenceError(jobId, error));
    },
    async flush(text: string) {
      if (text && text.length !== lastPatchedLength) await patch(text);
    }
  };
}

function makeJobId(kind: JobKind) {
  return `job-${kind}-${Date.now()}-${shortHash(`${kind}-${Date.now()}-${Math.random()}`)}`;
}

function defaultJobTitle(input: JobStartInput) {
  if (input.kind === "image-prompt-assist") return input.input.mode === "polish" ? "AI 润色提示词" : "AI 构图建议";
  if (input.kind === "image-generation") return "生成图片";
  if (input.kind === "write-copy") return "生成文案";
  if (input.kind === "account-style") return "生成账号风格卡";
  if (input.kind === "transcribe-video") return "转写视频";
  if (input.kind === "batch-transcribe") return input.input.updateStyle ? "批量转写并更新风格" : "批量转写";
  if (input.kind === "hotlist-refresh") return input.input.automatic ? "自动刷新视频热榜" : "刷新视频热榜";
  if (input.kind === "collect-account") return "采集账号";
  if (input.kind === "single-video-transcribe") return "提取单条视频文案";
  if (input.kind === "publish-copy") return "生成标题与发布文案";
  if (input.kind === "hotspot-refresh") return input.input.trendRadarIds ? "分析 TrendRadar 候选" : input.input.continueAnalysis ? "继续分析热点" : input.input.retryReport ? "重试热点日报" : "刷新热点雷达";
  if (input.kind === "gross-margin-refresh") return input.input.syncProjects ? "同步当月项目报价" : "批量刷新数据监控";
  if (input.input.sourceType === "record") return "补齐评论素材";
  return "生成评论素材";
}

function defaultInputSummary(input: JobStartInput) {
  if (input.kind === "image-generation" || input.kind === "image-prompt-assist") return input.input.prompt.slice(0, 60);
  if (input.kind === "write-copy") {
    if (input.input.action === "revise") return input.input.revisionScope === "selection" ? "选中段落续改" : "全文续改";
    return input.input.mode === "topic" ? "自由输入" : "素材改写";
  }
  if (input.kind === "account-style") return input.input.accountId;
  if (input.kind === "transcribe-video") return input.input.videoId;
  if (input.kind === "batch-transcribe") {
    const range = input.input.videoIds?.length
      ? `所选 ${input.input.videoIds.length} 条视频`
      : input.input.limit === "all"
        ? "全部待转写视频"
        : `${input.input.limit} 条待转写视频`;
    return `${input.input.accountId} · ${range}`;
  }
  if (input.kind === "hotlist-refresh") {
    return `${input.input.window} · ${input.input.accountIds?.length ? `${input.input.accountIds.length} 个账号` : "全部账号"}`;
  }
  if (input.kind === "collect-account") return `${input.input.platform === "bilibili" ? "B站" : "抖音"} · ${input.input.name}`;
  if (input.kind === "single-video-transcribe") return input.input.titleHint || input.input.url;
  if (input.kind === "publish-copy") return input.input.topicHint || input.input.sourceText.slice(0, 42);
  if (input.kind === "hotspot-refresh") return input.input.trendRadarIds ? `${input.input.trendRadarIds.length} 条 TrendRadar 候选` : input.input.continueAnalysis ? "已采集资讯中的未完成候选" : input.input.retryReport ? "已完成选题池" : "全量热点来源";
  if (input.kind === "gross-margin-refresh") return input.input.syncProjects ? "企业微信当月项目表" : input.input.recordIds?.length ? `${input.input.recordIds.length} 条记录` : "全部监控记录";
  if (input.input.sourceType === "draft") return "从草稿生成";
  if (input.input.sourceType === "url") return "从链接生成";
  if (input.input.sourceType === "record") return "补齐已有评论";
  return input.input.title || "从粘贴文案生成";
}

function defaultJobScope(input: JobStartInput): JobScope {
  if (input.kind === "image-generation") return { targetType: "text", sourceKey: shortHash(input.input.prompt), canvasId: input.input.canvasId };
  if (input.kind === "image-prompt-assist") return { targetType: "text", sourceKey: shortHash(input.input.prompt) };
  if (input.kind === "write-copy") {
    return compactJobScope({
      targetType: input.input.targetType,
      platform: input.input.platform,
      accountId: input.input.accountId,
      sourceKey: writeCopySourceKey(input.input)
    });
  }
  if (input.kind === "account-style") {
    return compactJobScope({
      targetType: "account",
      platform: input.input.platform,
      accountId: input.input.accountId
    });
  }
  if (input.kind === "transcribe-video") {
    return compactJobScope({
      targetType: "account",
      platform: input.input.platform,
      accountId: input.input.accountId,
      videoId: input.input.videoId
    });
  }
  if (input.kind === "batch-transcribe") {
    return compactJobScope({
      targetType: "account",
      platform: input.input.platform,
      accountId: input.input.accountId
    });
  }
  if (input.kind === "hotlist-refresh") {
    return compactJobScope({
      targetType: "hotlist",
      sourceKey: shortHash(`${input.input.window}-${(input.input.accountIds || []).join(",") || "all"}`)
    });
  }
  if (input.kind === "collect-account") {
    return compactJobScope({
      targetType: "account",
      platform: input.input.platform,
      sourceKey: shortHash(`${input.input.name}-${input.input.uidOrUrl || ""}`)
    });
  }
  if (input.kind === "single-video-transcribe") {
    return compactJobScope({ targetType: "url", sourceKey: shortHash(input.input.url) });
  }
  if (input.kind === "publish-copy") {
    return compactJobScope({ targetType: "text", sourceKey: shortHash(input.input.sourceText) });
  }
  if (input.kind === "hotspot-refresh") {
    return compactJobScope({ targetType: "hotspot", sourceKey: "all" });
  }
  if (input.kind === "gross-margin-refresh") {
    return compactJobScope({ targetType: "gross-margin", sourceKey: shortHash(input.input.syncProjects ? "project-orders" : (input.input.recordIds || ["all"]).join(",")) });
  }
  if (input.input.sourceType === "draft") {
    return compactJobScope({
      targetType: "draft",
      draftId: input.input.draftId
    });
  }
  if (input.input.sourceType === "record") {
    return compactJobScope({
      targetType: "engagement",
      engagementRecordId: input.input.recordId
    });
  }
  if (input.input.sourceType === "url") {
    return compactJobScope({
      targetType: "url",
      sourceKey: engagementSourceKey(input.input)
    });
  }
  return compactJobScope({
    targetType: "text",
    sourceKey: engagementSourceKey(input.input)
  });
}

function compactJobScope(scope: JobScope): JobScope {
  return Object.fromEntries(
    Object.entries(scope).filter(([, value]) => typeof value === "string" && value.trim())
  ) as JobScope;
}

function firstWriteResultContent(result: WriteGenerationResult) {
  return isWriteBatchResult(result) ? result.results[0]?.content : result.content;
}

function writeResultRef(result: WriteGenerationResult) {
  if (isWriteBatchResult(result)) {
    const firstResult = result.results[0];
    if (!firstResult?.draft) {
      return { href: "/writer", label: "查看写作台" };
    }
    return {
      id: firstResult.draft.id,
      href: buildWriterDraftHref(firstResult.draft),
      label: `查看 ${result.results.length} 篇文案`
    };
  }

  const firstResult = result;
  if (!firstResult?.draft) {
    return {
      href: "/writer",
      label: "查看写作台"
    };
  }

  return {
    id: firstResult.draft.id,
    href: buildWriterDraftHref(firstResult.draft),
    label: "查看文案"
  };
}

function isWriteBatchResult(result: WriteGenerationResult): result is WriteBatchResult {
  return "kind" in result && result.kind === "write-batch";
}

function summarizeBatchResult(result: BatchTranscribeResult) {
  return `批量转写完成：新增 ${result.completed}，跳过 ${result.skipped}，失败 ${result.failed}`;
}

function buildEngagementSuccessMessage(record: EngagementRecord) {
  const commentCount = record.comments?.items.length || 0;
  const danmakuCount = record.danmaku?.items.length || 0;
  const requestedCommentCount = record.comments?.requestedCount || 0;
  const requestedDanmakuCount = record.danmaku?.requestedCount || 0;
  const commentLabel = requestedCommentCount && commentCount < requestedCommentCount
    ? `${commentCount}/${requestedCommentCount} 条评论`
    : `${commentCount} 条评论`;
  const danmakuLabel = requestedDanmakuCount && danmakuCount < requestedDanmakuCount
    ? `${danmakuCount}/${requestedDanmakuCount} 条弹幕`
    : `${danmakuCount} 条弹幕`;
  if (commentCount && danmakuCount) return `已生成 ${commentLabel}和 ${danmakuLabel}`;
  if (commentCount) return `已生成 ${commentLabel}`;
  return `已生成 ${danmakuLabel}`;
}

function getJobAbortSignal(jobId: string) {
  return runtime.abortControllers.get(jobId)?.signal;
}

function maxActiveJobs() {
  const parsed = Number.parseInt(process.env.JOB_MAX_ACTIVE || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ACTIVE_JOBS;
  return Math.min(Math.max(parsed, 1), 6);
}

function jobHistoryLimit() {
  const parsed = Number.parseInt(process.env.JOB_HISTORY_LIMIT || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_JOB_HISTORY_LIMIT;
  return Math.min(Math.max(parsed, 50), 1000);
}

function jobHistoryMaxBytes() {
  const parsedMb = Number.parseInt(process.env.JOB_HISTORY_MAX_MB || "", 10);
  if (!Number.isFinite(parsedMb)) return DEFAULT_JOB_HISTORY_MAX_BYTES;
  return Math.min(Math.max(parsedMb, 5), 500) * 1024 * 1024;
}

function jobResultPersistBytes() {
  const parsedKb = Number.parseInt(process.env.JOB_RESULT_PERSIST_KB || "", 10);
  if (!Number.isFinite(parsedKb)) return DEFAULT_JOB_RESULT_PERSIST_BYTES;
  return Math.min(Math.max(parsedKb, 16), 1024) * 1024;
}

async function pruneJobHistory() {
  const limit = jobHistoryLimit();
  const maxBytes = jobHistoryMaxBytes();
  const jobs = await listJobSummariesFromDisk();
  let terminalCount = 0;
  let retainedBytes = 0;
  const removable: JobSummaryRead[] = [];

  for (const job of jobs) {
    const size = await fs.stat(job.filePath).then((stat) => stat.size).catch(() => 0);
    if (!isTerminalJob(job) || isJobExecuting(job.id)) {
      retainedBytes += size;
      continue;
    }

    const withinCount = terminalCount < limit;
    const withinBytes = retainedBytes + size <= maxBytes || terminalCount === 0;
    if (withinCount && withinBytes) {
      terminalCount += 1;
      retainedBytes += size;
    } else {
      removable.push(job);
    }
  }
  if (!removable.length) return;

  await Promise.all(
    removable.map(async (job) => {
      runtime.records.delete(job.id);
      runtime.pending.delete(job.id);
      await fs.rm(job.filePath, { force: true }).catch(() => undefined);
      await removeJobPayload(job.id);
      recordJobChange(job.id, true);
    })
  );
  invalidateJobSummaryCache();
}

function invalidateJobSummaryCache() {
  jobSummaryCache = null;
}

async function writeJobPayload(jobId: string, input: JobStartInput) {
  await ensureJobs();
  await writeJsonFile(jobPayloadPath(jobId), { schemaVersion: STORAGE_SCHEMA_VERSION, version: 1, input });
}

async function readJobPayload(jobId: string, expectedKind: JobKind): Promise<JobStartInput | null> {
  const target = jobPayloadPath(jobId);
  const raw = await readJsonFile<unknown>(target);
  if (raw === null && !await fileExists(target)) return null;
  if (raw && typeof raw === "object" && "version" in raw && raw.version !== 1) {
    throw new Error(`任务恢复参数版本不支持：${target}。请使用对应版本的程序，或重新发起任务。`);
  }
  const payload = parseStoredRecord<{ input: JobStartInput }>(target, raw, "job-payload");
  if (payload.input.kind !== expectedKind) throw new Error(`任务恢复参数类型不一致：${target}。请重新发起任务。`);
  runtime.readErrors.delete(target);
  return payload.input;
}

async function removeJobPayload(jobId: string) {
  await fs.rm(jobPayloadPath(jobId), { force: true }).catch(() => undefined);
}

function recordJobChange(jobId: string, removed = false) {
  runtime.changeRevision += 1;
  runtime.changeLog.push({ revision: runtime.changeRevision, jobId, ...(removed ? { removed: true } : {}) });
  if (runtime.changeLog.length > JOB_CHANGE_LOG_LIMIT) {
    runtime.changeLog.splice(0, runtime.changeLog.length - JOB_CHANGE_LOG_LIMIT);
  }
}

function jobChangeCursor() {
  return `${runtime.changeEpoch}.${runtime.changeRevision}`;
}

function parseJobChangeCursor(cursor?: string) {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf(".");
  if (separator < 1) return null;
  const epoch = cursor.slice(0, separator);
  const revision = Number.parseInt(cursor.slice(separator + 1), 10);
  if (!epoch || !Number.isSafeInteger(revision) || revision < 0) return null;
  return { epoch, revision };
}

function shouldRecordJobEvent(
  current: JobRecord,
  next: JobRecord,
  patch: Partial<JobRecord>
) {
  if (!("status" in patch) && !("stage" in patch) && !("message" in patch)) return false;
  return current.status !== next.status || current.stage !== next.stage || current.message !== next.message;
}

function appendJobEvent(events: JobEvent[] | undefined, event: JobEvent) {
  const last = events?.at(-1);
  if (
    last &&
    last.status === event.status &&
    last.stage === event.stage &&
    last.message === event.message
  ) {
    return events;
  }
  return [...(events || []), event].slice(-80);
}

function throwIfCancelled(jobId: string): asserts jobId is string {
  if (runtime.cancelRequests.has(jobId)) {
    throw new CancelledJobError();
  }
  const signal = getJobAbortSignal(jobId);
  if (signal?.aborted) throw signal.reason;
}

class CancelledJobError extends Error {
  constructor() {
    super("任务已停止");
    this.name = "CancelledJobError";
  }
}

function isCancelledJobError(error: unknown, signal?: AbortSignal) {
  if (error instanceof CancelledJobError) return true;
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /AbortError|aborted|任务已停止/i.test(error.message);
}

function toJobListItem(job: JobRecord): JobListItem {
  const { partialText, result, ...item } = withJobRecoveryError(job);
  return {
    ...item,
    error: item.error ? summarizeJobListText(item.error, 240) : undefined,
    events: item.events ? summarizeJobEvents(item.events) : undefined,
    inputSummary: item.inputSummary ? summarizeJobListText(item.inputSummary, 120) : undefined,
    message: summarizeJobListText(item.message, 160),
    hasPartialText: Boolean(partialText),
    hasResult: typeof result !== "undefined"
  };
}

function withJobRecoveryError<T extends JobRecord>(job: T): T {
  return { ...job, recoveryError: isTerminalJob(job) ? undefined : runtime.readErrors.get(jobPayloadPath(job.id)) };
}

function reportJobPersistenceError(jobId: string, error: unknown) {
  runtime.abortControllers.get(jobId)?.abort(error);
  runtime.pending.delete(jobId);
  const message = `任务 ${jobId} 状态保存失败：${error instanceof Error ? error.message : "请检查素材库访问权限和剩余空间。"}`;
  runtime.readErrors.set(jobPayloadPath(jobId), message);
  recordJobChange(jobId);
  console.error(message);
}

function summarizeJobEvents(events: JobEvent[]) {
  return events.slice(-JOB_SUMMARY_EVENT_LIMIT);
}

function summarizeJobListText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function compareJobsByUpdatedAtDesc(left: JobRecord, right: JobRecord) {
  return +new Date(right.updatedAt) - +new Date(left.updatedAt);
}
