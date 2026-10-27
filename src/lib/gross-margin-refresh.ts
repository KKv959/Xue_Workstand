import { mapWithConcurrency } from "./concurrency";
import {
  getBilibiliVideoStatsByUrl,
  getDouyinVideoAuthorNameByUrl,
  getDouyinVideoStatsBatchByUrl,
  getDouyinVideoStatsByUrl,
  resolveDouyinVideoUrl
} from "./opencli";
import type { OpenCliTimingSink } from "./opencli";
import {
  appendGrossMarginPlaySample,
  getGrossMarginMonitorRecords,
  resolveGrossMarginMonitorRecord,
  updateGrossMarginMonitorRecord
} from "./storage";
import type {
  GrossMarginMonitorRecord,
  GrossMarginPriceTable,
  GrossMarginServiceKind
} from "./types";
import {
  detectVideoPlatform,
  extractDouyinAwemeId,
  getVideoComparableKey,
  normalizeVideoUrlInput
} from "./platform-links";
import { shortHash } from "./utils";

const DOUYIN_VIDEO_STATS_CACHE_TTL_MS = 3 * 60 * 1000;
const MONITOR_REFRESH_LOG_PREFIX = "[gross-margin-monitor]";
const DEFAULT_MONITOR_REFRESH_CONCURRENCY = 6;
const MAX_MONITOR_REFRESH_CONCURRENCY = 6;

const douyinSingleVideoStatsCache = new Map<
  string,
  {
    expiresAt: number;
    promise: ReturnType<typeof getDouyinVideoStatsByUrl>;
  }
>();

type MonitorFetchedStats =
  | Awaited<ReturnType<typeof getBilibiliVideoStatsByUrl>>
  | Awaited<ReturnType<typeof getDouyinVideoStatsByUrl>>
  | Awaited<ReturnType<typeof getDouyinMonitorStats>>;

type MonitorPlatform = GrossMarginPriceTable["platform"];

export type GrossMarginRefreshOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: {
    completed: number;
    total: number;
    record: GrossMarginMonitorRecord;
  }) => void | Promise<void>;
};

export async function resolveGrossMarginVideoAccount(
  videoUrl: string,
  options: { signal?: AbortSignal } = {}
) {
  const normalizedUrl = normalizeVideoUrlInput(videoUrl);
  const platform = detectVideoPlatform(normalizedUrl);
  if (!platform) {
    throw new Error("没有识别到视频平台，请粘贴抖音或 B站单条视频链接。");
  }

  const resolvedUrl = platform === "douyin"
    ? await resolveDouyinVideoUrl(normalizedUrl, { signal: options.signal })
    : normalizedUrl;
  const fetched = platform === "bilibili"
    ? await getBilibiliVideoStatsByUrl(resolvedUrl, { signal: options.signal })
    : await getCachedDouyinVideoStatsByUrl(resolvedUrl, { signal: options.signal });
  const accountName = fetched.authorName?.trim() || (
    platform === "douyin"
      ? await getDouyinVideoAuthorNameByUrl(resolvedUrl, { signal: options.signal })
      : ""
  );
  if (!accountName) {
    throw new Error(`${platform === "bilibili" ? "B站" : "抖音"}视频已识别，但没有取得账号名，请手动填写。`);
  }

  return {
    platform,
    accountName,
    videoTitle: fetched.title?.trim() || "",
    currentPlayCount: normalizeFetchedStatsForMonitor(platform, fetched.stats).play ?? null,
    videoUrl: fetched.url || normalizedUrl
  };
}

export async function refreshGrossMarginMonitorRecord(recordId: string, options: GrossMarginRefreshOptions = {}) {
  const logger = createMonitorRefreshLogger("refresh-one", { recordId });
  let refreshed: GrossMarginMonitorRecord | null = null;
  try {
    const record = await timeMonitorOperation(
      logger.onTiming,
      "storage.resolve-monitor-record",
      () => resolveGrossMarginMonitorRecord(recordId),
      { recordId }
    );
    refreshed = await refreshMonitorRecordSnapshot(record, logger.onTiming, options.signal);
    return refreshed;
  } finally {
    logger.finish(refreshed?.status || "failed", refreshed ? recordTimingMeta(refreshed) : { recordId });
  }
}

async function refreshMonitorRecordSnapshot(
  record: GrossMarginMonitorRecord,
  onTiming?: OpenCliTimingSink,
  signal?: AbortSignal
) {
  const meta = recordTimingMeta(record);
  try {
    const fetched = await timeMonitorOperation(
      onTiming,
      `${record.platform}.record.fetch-total`,
      () => fetchMonitorRecordStats(record, onTiming, meta, signal),
      meta
    );
    return await saveRefreshedMonitorRecord(record, fetched, onTiming);
  } catch (error) {
    throwIfAborted(signal);
    if (isRevisionConflict(error)) return resolveGrossMarginMonitorRecord(record.id);
    return saveFailedMonitorRecord(record, error, onTiming);
  }
}

function fetchMonitorRecordStats(
  record: GrossMarginMonitorRecord,
  onTiming: OpenCliTimingSink | undefined,
  meta: MonitorTimingMeta,
  signal?: AbortSignal
): Promise<MonitorFetchedStats> {
  if (record.platform === "bilibili") {
    return getBilibiliVideoStatsByUrl(record.videoUrl, {
      onTiming,
      timingMeta: meta,
      signal
    });
  }
  return getDouyinMonitorStats({
    accountName: record.accountName,
    url: record.videoUrl
  }, {
    onTiming,
    timingMeta: meta,
    signal
  });
}

async function saveRefreshedMonitorRecord(
  record: GrossMarginMonitorRecord,
  fetched: MonitorFetchedStats,
  onTiming?: OpenCliTimingSink
) {
  const warnings: string[] = [];
  try {
    if ("warning" in fetched && typeof fetched.warning === "string" && fetched.warning) warnings.push(fetched.warning);
    const refreshedAt = new Date().toISOString();
    return await timeMonitorOperation(
      onTiming,
      "storage.save-monitor-record",
      () => updateGrossMarginMonitorRecord(record.id, (current) => {
        const fetchedStats = normalizeFetchedStatsForMonitor(current.platform, fetched.stats);
        if (!Object.keys(fetchedStats).length) throw new Error("没有取得有效监控指标，已保留上次成功数据，请重试。");
        const expectedServices: GrossMarginServiceKind[] = current.platform === "douyin"
          ? ["like", "comment", "favorite", "share"]
          : ["play", "like", "coin", "favorite", "comment", "share", "danmaku"];
        if (expectedServices.some(service => fetchedStats[service] === undefined)) {
          warnings.push("部分指标未返回，缺失项保留上次成功数据，请重试。");
        }
        const currentStats =
          current.platform === "douyin" && typeof current.currentStats?.play === "number"
            ? { ...current.currentStats, ...fetchedStats, play: current.currentStats.play }
            : { ...current.currentStats, ...fetchedStats };
        const shouldCapturePlaySample =
          typeof fetchedStats.play === "number" && Number.isFinite(fetchedStats.play) && currentStats.play === fetchedStats.play;
        const playSamples = shouldCapturePlaySample
          ? appendGrossMarginPlaySample(current.playSamples, currentStats.play, refreshedAt, "refresh")
          : current.playSamples;
        return {
          ...current,
          accountName: current.accountName || getFetchedAuthorName(fetched),
          title: fetched.title || current.title,
          videoUrl: fetched.url || current.videoUrl,
          videoKey:
            "videoKey" in fetched && typeof fetched.videoKey === "string" && fetched.videoKey
              ? fetched.videoKey
              : fetched.url
                ? getVideoComparableKey(fetched.url)
                : current.videoKey,
          publishedAt: fetched.publishedAt || current.publishedAt,
          previousStats: current.currentStats,
          currentStats,
          playSamples,
          status: warnings.length ? "partial" : "completed",
          warnings,
          lastRefreshedAt: refreshedAt,
          updatedAt: refreshedAt
        };
      }, record.revision),
      recordTimingMeta(record)
    );
  } catch (error) {
    if (isRevisionConflict(error)) return resolveGrossMarginMonitorRecord(record.id);
    return saveFailedMonitorRecord(record, error, onTiming);
  }
}

function getFetchedAuthorName(
  fetched:
    | Awaited<ReturnType<typeof getBilibiliVideoStatsByUrl>>
    | Awaited<ReturnType<typeof getDouyinVideoStatsByUrl>>
    | Awaited<ReturnType<typeof getDouyinMonitorStats>>
) {
  return "authorName" in fetched ? fetched.authorName?.trim() || "" : "";
}

function saveFailedMonitorRecord(record: GrossMarginMonitorRecord, error: unknown, onTiming?: OpenCliTimingSink) {
  const failedAt = new Date().toISOString();
  return timeMonitorOperation(
    onTiming,
    "storage.save-failed-monitor-record",
    () => updateGrossMarginMonitorRecord(record.id, (current) => ({
      ...current,
      status: "failed",
      warnings: [error instanceof Error ? error.message : "刷新监控数据失败"],
      lastRefreshedAt: failedAt,
      updatedAt: failedAt
    }), record.revision),
    recordTimingMeta(record)
  ).catch((saveError) => {
    if (isRevisionConflict(saveError)) return resolveGrossMarginMonitorRecord(record.id);
    throw saveError;
  });
}

function isRevisionConflict(error: unknown) {
  return error instanceof Error && "statusCode" in error && error.statusCode === 409;
}

export async function refreshGrossMarginMonitorRecords(recordIds?: string[], options: GrossMarginRefreshOptions = {}) {
  const logger = createMonitorRefreshLogger("refresh-many", {
    requestedRecordCount: recordIds?.length || "all"
  });
  let refreshed: GrossMarginMonitorRecord[] = [];
  let status = "completed";
  const requestedIds = recordIds?.length ? new Set(recordIds.map((recordId) => recordId.trim())) : null;
  try {
    const records = await timeMonitorOperation(
      logger.onTiming,
      "storage.load-monitor-records",
      async () => (await getGrossMarginMonitorRecords()).filter((record) => !requestedIds || requestedIds.has(record.id)),
      { requestedRecordCount: recordIds?.length || "all" }
    );
    logger.info("records-selected", {
      recordCount: records.length,
      douyinCount: records.filter((record) => record.platform === "douyin").length,
      bilibiliCount: records.filter((record) => record.platform === "bilibili").length
    });
    const douyinRecords = records.filter((record) => record.platform === "douyin");
    const douyinResults = douyinRecords.length
      ? await timeMonitorOperation(
          logger.onTiming,
          "douyin.batch.fetch-total",
          () => getDouyinVideoStatsBatchByUrl(douyinRecords.map((record) => record.videoUrl), {
            onTiming: logger.onTiming,
            timingMeta: { platform: "douyin", mode: "batch", count: douyinRecords.length },
            signal: options.signal
          }),
          { count: douyinRecords.length }
        ).catch(() => {
          throwIfAborted(options.signal);
          return [];
        })
      : [];
    const douyinFetchedById = new Map(
      douyinRecords.flatMap((record, index) => {
        const result = douyinResults[index];
        return result ? [[record.id, result] as const] : [];
      })
    );

    const concurrency = monitorRefreshConcurrency();
    let completed = 0;
    refreshed = await timeMonitorOperation(
      logger.onTiming,
      "monitor.records.process",
      () => mapWithConcurrency(records, concurrency, async (record) => {
        throwIfAborted(options.signal);
        const fetched = douyinFetchedById.get(record.id);
        const refreshedRecord = fetched
          ? await saveRefreshedMonitorRecord(record, fetched, logger.onTiming)
          : await refreshMonitorRecordSnapshot(record, logger.onTiming, options.signal);
        completed += 1;
        await options.onProgress?.({
          completed,
          total: records.length,
          record: refreshedRecord
        });
        return refreshedRecord;
      }),
      { recordCount: records.length, concurrency }
    );
    return refreshed;
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    logger.finish(status, {
      refreshedCount: refreshed.length,
      failedCount: refreshed.filter((record) => record.status === "failed").length
    });
  }
}

function monitorRefreshConcurrency() {
  const parsed = Number.parseInt(process.env.GROSS_MARGIN_MONITOR_REFRESH_CONCURRENCY || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MONITOR_REFRESH_CONCURRENCY;
  return Math.max(1, Math.min(parsed, MAX_MONITOR_REFRESH_CONCURRENCY));
}

function normalizeFetchedStatsForMonitor(
  platform: MonitorPlatform,
  stats: Partial<Record<GrossMarginServiceKind, number>>
) {
  const services: GrossMarginServiceKind[] = platform === "bilibili"
    ? ["play", "like", "coin", "favorite", "comment", "share", "danmaku"]
    : ["play", "like", "comment", "favorite", "share"];
  const normalized: Partial<Record<GrossMarginServiceKind, number>> = {};
  for (const service of services) {
    const value = stats[service];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) normalized[service] = value;
  }
  return normalized;
}

async function getDouyinMonitorStats(input: {
  accountName: string;
  url: string;
}, options: {
  timingMeta?: MonitorTimingMeta;
  onTiming?: OpenCliTimingSink;
  signal?: AbortSignal;
} = {}) {
  return getCachedDouyinVideoStatsByUrl(input.url, options);
}

function getCachedDouyinVideoStatsByUrl(url: string, options: {
  timingMeta?: MonitorTimingMeta;
  onTiming?: OpenCliTimingSink;
  signal?: AbortSignal;
} = {}) {
  const cacheKey = extractDouyinAwemeId(url) || normalizeVideoUrlInput(url);
  const now = Date.now();
  const existing = douyinSingleVideoStatsCache.get(cacheKey);
  if (existing && existing.expiresAt > now) {
    options.onTiming?.({
      stage: "douyin.single-cache-hit",
      ms: 0,
      ok: true,
      meta: options.timingMeta
    });
    return existing.promise;
  }

  const pending = getDouyinVideoStatsByUrl(url, {
    onTiming: options.onTiming,
    timingMeta: options.timingMeta,
    signal: options.signal
  }).catch((error) => {
    const current = douyinSingleVideoStatsCache.get(cacheKey);
    if (current?.promise === pending) douyinSingleVideoStatsCache.delete(cacheKey);
    throw error;
  });
  douyinSingleVideoStatsCache.set(cacheKey, {
    expiresAt: now + DOUYIN_VIDEO_STATS_CACHE_TTL_MS,
    promise: pending
  });
  return pending;
}

type MonitorTimingMeta = Record<string, string | number | boolean | null | undefined>;

function createMonitorRefreshLogger(action: string, meta: MonitorTimingMeta = {}) {
  const runId = `${Date.now().toString(36)}-${shortHash(`${action}-${JSON.stringify(meta)}`)}`;
  const startedAt = Date.now();
  logMonitorRefreshEvent("start", {
    runId,
    action,
    meta: compactMonitorMeta(meta)
  });

  const onTiming: OpenCliTimingSink = (entry) => {
    logMonitorRefreshEvent("timing", {
      runId,
      action,
      stage: entry.stage,
      ms: entry.ms,
      ok: entry.ok,
      meta: compactMonitorMeta(entry.meta),
      error: entry.error
    });
  };

  return {
    onTiming,
    info(event: string, payload: MonitorTimingMeta = {}) {
      logMonitorRefreshEvent(event, {
        runId,
        action,
        meta: compactMonitorMeta(payload)
      });
    },
    finish(status: string, payload: MonitorTimingMeta = {}) {
      logMonitorRefreshEvent("finish", {
        runId,
        action,
        status,
        totalMs: Date.now() - startedAt,
        meta: compactMonitorMeta(payload)
      });
    }
  };
}

async function timeMonitorOperation<T>(
  onTiming: OpenCliTimingSink | undefined,
  stage: string,
  operation: () => Promise<T>,
  meta?: MonitorTimingMeta
) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    onTiming?.({
      stage,
      ms: Date.now() - startedAt,
      ok: true,
      meta: compactMonitorMeta(meta)
    });
    return result;
  } catch (error) {
    onTiming?.({
      stage,
      ms: Date.now() - startedAt,
      ok: false,
      meta: compactMonitorMeta(meta),
      error: formatMonitorTimingError(error)
    });
    throw error;
  }
}

function recordTimingMeta(record: GrossMarginMonitorRecord): MonitorTimingMeta {
  return {
    recordId: record.id,
    platform: record.platform,
    videoKey: record.videoKey || getVideoComparableKey(record.videoUrl),
    accountName: record.accountName || ""
  };
}

function compactMonitorMeta(meta?: MonitorTimingMeta) {
  if (!meta) return undefined;
  const compact: MonitorTimingMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined && value !== "") compact[key] = value;
  }
  return Object.keys(compact).length ? compact : undefined;
}

function logMonitorRefreshEvent(event: string, payload: Record<string, unknown>) {
  const compactPayload = Object.fromEntries(
    Object.entries({
      at: new Date().toISOString(),
      event,
      ...payload
    }).filter(([, value]) => value !== undefined)
  );
  console.log(`${MONITOR_REFRESH_LOG_PREFIX} ${JSON.stringify(compactPayload)}`);
}

function formatMonitorTimingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("请求已取消");
  error.name = "AbortError";
  throw error;
}
