import { generateStyleProfile } from "./ai";
import {
  getDouyinAwemeId,
  getDouyinVideoDownloadLookupLimit,
  getDouyinVideoDownloadUrls
} from "./opencli";
import { getAccountSummary, markTranscriptFailed, resolveAccount } from "./storage";
import { transcribeVideo } from "./transcription";
import { Account, BatchTranscribeResult, Platform, Video } from "./types";

export type BatchTranscribeInput = {
  platform: Platform;
  accountId: string;
  limit: number | "all";
  videoIds?: string[];
  updateStyle?: boolean;
};

export type BatchTranscribeVideoEvent = {
  phase: "video";
  videoId: string;
  title: string;
  status: "completed" | "skipped" | "failed";
  source?: Video["transcriptSource"] | string;
  error?: string;
  timings?: Timing[];
  completed: number;
  skipped: number;
  failed: number;
};

export type BatchTranscribeHooks = {
  onCandidates?: (videoIds: string[]) => Promise<void>;
  onPrepare?: () => void;
  onMediaPreloadStart?: (payload: { total: number }) => void;
  onVideoStart?: (payload: { index: number; total: number; video: Video }) => void;
  onVideoResult?: (payload: BatchTranscribeVideoEvent) => void | Promise<void>;
  onTranscribeComplete?: (payload: Pick<BatchTranscribeResult, "completed" | "skipped" | "failed">) => void | Promise<void>;
  onStyleStart?: () => void;
  onFinalize?: () => void;
  signal?: AbortSignal;
};

type BatchVideoResult = BatchTranscribeResult["results"][number];
type Timing = NonNullable<BatchTranscribeResult["timings"]>[number];

export async function runBatchTranscribe(
  input: BatchTranscribeInput,
  hooks: BatchTranscribeHooks = {}
): Promise<BatchTranscribeResult> {
  throwIfAborted(hooks.signal);
  hooks.onPrepare?.();
  const totalStartedAt = Date.now();

  const account = await resolveAccount(input.platform, input.accountId);
  const summary = await getAccountSummary(account);
  const candidates = selectCandidates(summary.videos, input);
  await hooks.onCandidates?.(candidates.map((video) => video.id));
  throwIfAborted(hooks.signal);

  const result: BatchTranscribeResult = {
    account: summary,
    requested: candidates.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    timings: [],
    results: []
  };

  pushTiming(result, "prepare", totalStartedAt);
  await processVideos(input, hooks, result, account, candidates);
  throwIfAborted(hooks.signal);

  const candidateOrder = new Map(candidates.map((video, index) => [video.id, index]));
  result.results.sort((a, b) => (candidateOrder.get(a.videoId) ?? 0) - (candidateOrder.get(b.videoId) ?? 0));

  pushTiming(result, "transcribe-phase-total", totalStartedAt);
  await hooks.onTranscribeComplete?.({
    completed: result.completed,
    skipped: result.skipped,
    failed: result.failed
  });

  if (input.updateStyle) {
    throwIfAborted(hooks.signal);
    hooks.onStyleStart?.();
    try {
      const styleResult = await generateStyleProfile(input.platform, input.accountId, { signal: hooks.signal });
      result.style = styleResult.style;
      result.styleUpdated = true;
      result.fallback = styleResult.fallback;
      result.fallbackReason = styleResult.fallbackReason;
      result.usedModel = styleResult.usedModel;
    } catch (error) {
      if (isAbortError(error)) throw error;
      result.styleUpdated = false;
      result.styleError = error instanceof Error ? error.message : "风格卡更新失败";
    }
  }

  result.account = await getAccountSummary(account);
  throwIfAborted(hooks.signal);
  pushTiming(result, "total", totalStartedAt);
  hooks.onFinalize?.();
  return result;
}

function selectCandidates(videos: Video[], input: BatchTranscribeInput) {
  if (input.videoIds !== undefined) {
    const requestedIds = [...new Set(input.videoIds)];
    const byId = new Map(videos.map((video) => [video.id, video]));
    const missingIds = requestedIds.filter((videoId) => !byId.has(videoId));
    if (missingIds.length) {
      throw new Error(`有 ${missingIds.length} 条视频不属于当前账号，请刷新列表后重试。`);
    }
    const pending = requestedIds.map((videoId) => byId.get(videoId)!).filter((video) => !videoHasTranscript(video));
    return input.limit === "all" ? pending : pending.slice(0, Math.max(0, input.limit));
  }

  const pendingVideos = videos.filter((video) => !videoHasTranscript(video));
  const limit = input.limit === "all" ? pendingVideos.length : Math.min(input.limit, pendingVideos.length);
  return pendingVideos.slice(0, limit);
}

async function processVideos(
  input: BatchTranscribeInput,
  hooks: BatchTranscribeHooks,
  result: BatchTranscribeResult,
  account: Account,
  candidates: Video[]
) {
  throwIfAborted(hooks.signal);
  const concurrency = input.platform === "douyin" ? resolveDouyinBatchConcurrency() : 1;
  let douyinMediaUrls = new Map<string, string>();
  if (input.platform === "douyin") {
    const pendingCount = candidates.filter((video) => !videoHasTranscript(video)).length;
    if (pendingCount) hooks.onMediaPreloadStart?.({ total: pendingCount });
  douyinMediaUrls = await preloadDouyinMediaUrls(account, candidates, result, hooks.signal);
  }
  let nextIndex = 0;
  let stopped = false;

  async function worker() {
    try {
      while (!stopped && nextIndex < candidates.length) {
        throwIfAborted(hooks.signal);
        const index = nextIndex;
        nextIndex += 1;
        const video = candidates[index];
        await processVideo(input, hooks, result, video, index, candidates.length, douyinMediaUrls.get(video.id));
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  }

  // Wait for in-flight saves before the job releases its concurrency slot.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function preloadDouyinMediaUrls(
  account: Account,
  candidates: Video[],
  result: BatchTranscribeResult,
  signal?: AbortSignal
) {
  const pendingVideos = candidates.filter((video) => !videoHasTranscript(video));
  const urls = new Map<string, string>();
  if (!pendingVideos.length) return urls;

  const startedAt = Date.now();
  try {
    const lookupLimit = getDouyinVideoDownloadLookupLimit(pendingVideos);
    const mediaUrlsByAwemeId = await getDouyinVideoDownloadUrls(account, { limit: lookupLimit, signal });
    for (const video of pendingVideos) {
      const awemeId = getDouyinAwemeId(video);
      const mediaUrl = awemeId ? mediaUrlsByAwemeId.get(awemeId) : "";
      if (mediaUrl) urls.set(video.id, mediaUrl);
    }
    result.timings?.push({ stage: "douyin-preload-media", ms: Date.now() - startedAt });
  } catch (error) {
    if (isAbortError(error)) throw error;
    result.timings?.push({ stage: "douyin-preload-media-failed", ms: Date.now() - startedAt });
  }

  return urls;
}

async function processVideo(
  input: BatchTranscribeInput,
  hooks: BatchTranscribeHooks,
  result: BatchTranscribeResult,
  video: Video,
  index: number,
  total: number,
  douyinMediaUrl?: string
) {
  hooks.onVideoStart?.({ index, total, video });
  throwIfAborted(hooks.signal);

  if (videoHasTranscript(video)) {
    result.skipped += 1;
    const event = buildVideoEvent(result, {
      video,
      status: "skipped",
      source: video.transcriptSource || "existing"
    });
    appendVideoResult(result, event);
    await hooks.onVideoResult?.(event);
    return;
  }

  let event: BatchTranscribeVideoEvent;
  try {
    const startedAt = Date.now();
    throwIfAborted(hooks.signal);
    const transcribed = await transcribeVideo({
      platform: input.platform,
      accountId: input.accountId,
      videoId: video.id,
      douyinMediaUrl,
      allowRemoteDownload: true,
      signal: hooks.signal
    });
    const timings = "timings" in transcribed ? transcribed.timings : undefined;
    result.completed += 1;
    event = buildVideoEvent(result, {
      video,
      status: "completed",
      source: transcribed.video.transcriptSource || transcribed.usedProvider,
      timings: timings || [{ stage: "total", ms: Date.now() - startedAt }]
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    result.failed += 1;
    const message = error instanceof Error ? error.message : "转写失败";
    if (input.platform === "douyin" && !(error && typeof error === "object" && "statusCode" in error && error.statusCode === 409)) {
      await markTranscriptFailed(input.platform, input.accountId, video.id, message);
    }
    event = buildVideoEvent(result, {
      video,
      status: "failed",
      error: message
    });
  }
  appendVideoResult(result, event);
  await hooks.onVideoResult?.(event);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /aborted|任务已停止/i.test(error.message));
}

function createAbortError() {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}

function appendVideoResult(result: BatchTranscribeResult, event: BatchTranscribeVideoEvent) {
  const item: BatchVideoResult = {
    videoId: event.videoId,
    title: event.title,
    status: event.status,
    source: event.source,
    error: event.error,
    timings: event.timings
  };
  result.results.push(item);
}

function pushTiming(result: BatchTranscribeResult, stage: string, startedAt: number) {
  result.timings?.push({ stage, ms: Date.now() - startedAt });
}

function resolveDouyinBatchConcurrency() {
  const parsed = Number.parseInt(process.env.DOUYIN_TRANSCRIBE_CONCURRENCY || "", 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(parsed, 1), 4);
}

function videoHasTranscript(video: Pick<Video, "transcriptStatus" | "transcriptPath">) {
  return video.transcriptStatus === "completed" || Boolean(video.transcriptPath);
}

function buildVideoEvent(
  result: Pick<BatchTranscribeResult, "completed" | "skipped" | "failed">,
  input: {
    video: Video;
    status: BatchTranscribeVideoEvent["status"];
    source?: BatchTranscribeVideoEvent["source"];
    error?: string;
    timings?: Timing[];
  }
): BatchTranscribeVideoEvent {
  return {
    phase: "video",
    videoId: input.video.id,
    title: input.video.title,
    status: input.status,
    source: input.source,
    error: input.error,
    timings: input.timings,
    completed: result.completed,
    skipped: result.skipped,
    failed: result.failed
  };
}
