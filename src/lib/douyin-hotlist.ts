import { mapWithConcurrency } from "./concurrency";
import {
  formatHotlistSurgeReason,
  getHotlistSurgeDecision,
  getHotlistSurgeLabel,
  getSurgeMinHeatPerHour,
  isHotlistSurgeActive,
  isHotlistSurgeStateAboveThreshold,
  shouldRetainHotlistSurgeState,
  isHotlistSurgeEligible
} from "./douyin-hotlist-surge";
import {
  collectDouyinPostVideosBatch,
  collectVideos,
  resolveAccountUid
} from "./opencli";
import { inferAccountAvatarFromCollectedData, resolveAccountProfile } from "./account-profile";
import {
  calculateHotlistInteractionHeat,
  calculateHotlistRankScore,
  calculateHotlistVelocity
} from "./douyin-hotlist-score";
import {
  addDouyinHotlistAccountRef,
  findDouyinHotlistAccountByName,
  findDouyinHotlistAccountByUid,
  getDouyinHotlistAccountVideos,
  recordDouyinHotlistRefresh,
  readDouyinHotlistWatchlist,
  removeDouyinHotlistAccountRefs,
  resolveDouyinHotlistAccount,
  saveDouyinHotlistVideos,
  upsertDouyinHotlistAccount,
  withDouyinHotlistMutationLock
} from "./storage/douyin-hotlist";
import type {
  Account,
  DouyinHotlistAccount,
  DouyinHotlistItem,
  DouyinHotlistRefreshAccountResult,
  DouyinHotlistRefreshResult,
  DouyinHotlistResponse,
  DouyinHotlistSurgeHighlight,
  Platform,
  Video,
  VideoHotlistSurgeState,
  VideoHotlistTrend
} from "./types";
import { extractLinksFromInput } from "./platform-links";
import { nowIso, shortHash } from "./utils";

const DEFAULT_WINDOW_KEY = "3d";
const DEFAULT_WINDOW_DAYS = 3;
const DEFAULT_REFRESH_LIMIT = 60;
const MAX_REFRESH_LIMIT = 120;
const MAX_WINDOW_DAYS = 14;
const DEFAULT_REFRESH_CONCURRENCY = 2;
const MAX_REFRESH_CONCURRENCY = 5;
const EXPLOSIVE_MAX_AGE_HOURS = 3;
const EXPLOSIVE_MIN_LIKES = 1000;
const EXPLOSIVE_MIN_HEAT_PER_HOUR = 22 * 300;
const FAST_RISING_MAX_AGE_HOURS = 12;
const FAST_RISING_MIN_LIKES = 500;
const FAST_RISING_MIN_HEAT_PER_HOUR = 22 * 220;
const STALE_LOW_HEAT_MAX_AGE_HOURS = 12;
const STALE_LOW_HEAT_MIN_SCORE = 50_000;
const DOUYIN_SEC_UID_PATTERN = /MS4wLjAB[0-9A-Za-z_.-]{20,}/;
const BILIBILI_UID_PATTERN = /^\d{4,}$/;

const globalHotlistRuntime = globalThis as typeof globalThis & {
  __styleWorkbenchHotlistRefreshPromise?: Promise<DouyinHotlistRefreshResult> | null;
};

export type DouyinHotlistRefreshProgress = {
  completed: number;
  total: number;
  result: DouyinHotlistRefreshAccountResult;
};

class DouyinHotlistRefreshInProgressError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("视频热榜正在刷新中，请等这一轮结束后再试。");
    this.name = "DouyinHotlistRefreshInProgressError";
  }
}

export async function getDouyinHotlist(options: { force?: boolean; windowDays?: number; windowKey?: string } = {}): Promise<DouyinHotlistResponse> {
  const window = resolveHotlistWindow(options.windowKey || options.windowDays);
  const watchlist = await readDouyinHotlistWatchlist();
  const resolved = await resolveWatchlistAccounts(watchlist.accountIds);
  const accountVideos = await Promise.all(
    resolved.accounts.map(async (account) => ({
      account,
      videos: await getDouyinHotlistAccountVideos(account, { force: options.force })
    }))
  );
  const accountRankItems = accountVideos.map(({ account, videos }) => ({
    account,
    videos,
    rankItems: videos
      .filter((video) => isVideoInWindow(video, window))
      .map((video) => buildRankItem(account, video, window))
      .filter(shouldShowHotlistRankItem)
  }));

  const accounts: DouyinHotlistAccount[] = accountRankItems.map(({ account, videos, rankItems }) => {
    return {
      id: account.id,
      slug: account.slug,
      platform: account.platform,
      name: account.name,
      uid: account.uid,
      sourceUrl: account.sourceUrl,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastCollectedAt: account.lastCollectedAt,
      videoCount: videos.length,
      recentVideoCount: rankItems.length
    };
  });

  const rankedItems = accountRankItems
    .flatMap(({ rankItems }) => rankItems)
    .sort((left, right) => right.heatScore - left.heatScore || comparePublishedAtDesc(left.video, right.video));
  const items = rankedItems.map((item, index) => finalizeRankItem(item, index));

  return {
    accounts,
    items,
    groups: watchlist.groups ?? [],
    groupRevision: watchlist.groupRevision ?? 0,
    summary: {
      windowDays: window.windowDays,
      windowKey: window.windowKey,
      windowLabel: window.label,
      windowHours: window.windowHours,
      fromDate: window.fromDate,
      toDate: window.toDate,
      accountCount: accounts.length,
      staleAccountIds: resolved.staleAccountIds,
      totalVideoCount: accountVideos.reduce((sum, current) => sum + current.videos.length, 0),
      recentVideoCount: items.length,
      lastRefreshedAt: watchlist.lastRefreshedAt,
      lastFullRefreshAttemptAt: watchlist.lastFullRefreshAttemptAt || watchlist.lastRefreshedAt,
      lastFullRefreshAt: watchlist.lastFullRefreshAt || watchlist.lastRefreshedAt
    }
  };
}

export async function addDouyinHotlistAccount(input: {
  platform: Platform;
  query: string;
  signal?: AbortSignal;
  windowDays?: number;
  windowKey?: string;
}) {
  const target = resolveAccountTarget(input.platform, input.query);
  const existingByName = target.uidOrUrl ? null : await findDouyinHotlistAccountByName(input.platform, target.lookupName);
  const uid =
    existingByName?.uid ||
    (await resolveAccountUid(input.platform, target.lookupName, target.uidOrUrl, { signal: input.signal }));
  const existingByUid = await findDouyinHotlistAccountByUid(input.platform, uid);
  const profile = await resolveAccountProfile({
    platform: input.platform,
    uid,
    fallbackName: existingByUid?.name || existingByName?.name || target.displayName,
    sourceUrl: existingByUid?.sourceUrl || existingByName?.sourceUrl || target.sourceUrl,
    signal: input.signal
  });
  await withDouyinHotlistMutationLock(async () => {
    const account = await upsertDouyinHotlistAccount({
      platform: input.platform,
      name: profile.name,
      uid,
      sourceUrl: profile.sourceUrl,
      avatarUrl: profile.avatarUrl
    });
    await addDouyinHotlistAccountRef(account.id);
  });
  return getDouyinHotlist({ windowDays: input.windowDays, windowKey: input.windowKey });
}

export async function removeDouyinHotlistAccount(
  accountId: string,
  options: { windowDays?: number; windowKey?: string } = {}
) {
  await removeDouyinHotlistAccountRefs([accountId]);
  return getDouyinHotlist(options);
}

export async function refreshDouyinHotlist(options: {
  accountIds?: string[];
  limit?: number;
  windowDays?: number;
  windowKey?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DouyinHotlistRefreshProgress) => void | Promise<void>;
} = {}): Promise<DouyinHotlistRefreshResult> {
  if (globalHotlistRuntime.__styleWorkbenchHotlistRefreshPromise) {
    throw new DouyinHotlistRefreshInProgressError();
  }

  const refreshPromise = refreshDouyinHotlistUnlocked(options);
  globalHotlistRuntime.__styleWorkbenchHotlistRefreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (globalHotlistRuntime.__styleWorkbenchHotlistRefreshPromise === refreshPromise) {
      globalHotlistRuntime.__styleWorkbenchHotlistRefreshPromise = null;
    }
  }
}

async function refreshDouyinHotlistUnlocked(options: {
  accountIds?: string[];
  limit?: number;
  windowDays?: number;
  windowKey?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DouyinHotlistRefreshProgress) => void | Promise<void>;
} = {}): Promise<DouyinHotlistRefreshResult> {
  const window = resolveHotlistWindow(options.windowKey || options.windowDays);
  const limit = clampInteger(options.limit, 1, MAX_REFRESH_LIMIT, DEFAULT_REFRESH_LIMIT);
  const watchlist = await readDouyinHotlistWatchlist();
  const targetIds = options.accountIds ? uniqueAccountIds(options.accountIds) : watchlist.accountIds;
  if (!targetIds.length) throw new Error("视频热榜账号池为空，请先添加账号。");
  const resolved = await resolveWatchlistAccounts(targetIds);
  const concurrency = resolveRefreshConcurrency(resolved.accounts.length);
  let processedCount = 0;
  const reportProgress = async (result: DouyinHotlistRefreshAccountResult) => {
    processedCount += 1;
    await options.onProgress?.({ completed: processedCount, total: targetIds.length, result });
  };
  const results = await refreshDouyinHotlistAccounts(
    resolved.accounts,
    window,
    limit,
    concurrency,
    options.signal,
    reportProgress
  );

  const completed = results.filter((result) => result.status === "completed").length;
  const unchanged = results.filter((result) => result.status === "unchanged").length;
  const staleResults = resolved.staleAccountIds.map((accountId) => ({
    accountId,
    name: accountId,
    status: "failed" as const,
    error: "热榜关注列表里的账号已经不存在。"
  }));
  for (const staleResult of staleResults) await reportProgress(staleResult);
  const failed = results.length - completed - unchanged + staleResults.length;
  const isFullRefresh = hasSameAccountIds(targetIds, watchlist.accountIds);
  await recordDouyinHotlistRefresh({
    attemptedAt: nowIso(),
    changed: completed > 0,
    full: isFullRefresh,
    successful: failed === 0
  });

  const snapshot = await getDouyinHotlist({ windowKey: window.windowKey });

  return {
    ...snapshot,
    refresh: {
      requested: targetIds.length,
      completed,
      unchanged,
      failed,
      limit,
      accounts: [...results, ...staleResults]
    }
  };
}

type HotlistWindow = {
  windowKey: string;
  label: string;
  windowDays: number;
  windowHours?: number;
  fromDate: string;
  toDate: string;
  fromTime: number;
  toTime: number;
};

async function refreshDouyinHotlistAccount(
  account: Account,
  window: HotlistWindow,
  limit: number,
  signal?: AbortSignal,
  retryReason?: string
): Promise<DouyinHotlistRefreshAccountResult> {
  throwIfAborted(signal);

  try {
    const collected = await collectVideos({
      platform: account.platform,
      account,
      limit,
      order: getHotlistCollectOrder(account.platform),
      fromDate: account.platform === "douyin" ? window.fromDate : undefined,
      toDate: account.platform === "douyin" ? window.toDate : undefined,
      signal
    });
    throwIfAborted(signal);
    return saveDouyinHotlistRefreshResult(account, collected.videos, collected.rawCount, {
      mode: "single",
      raw: collected.raw,
      retried: Boolean(retryReason),
      retryReason
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      accountId: account.id,
      name: account.name,
      status: "failed",
      error: error instanceof Error ? error.message : `${formatPlatformName(account.platform)}热榜刷新失败`,
      mode: "single",
      retried: Boolean(retryReason),
      retryReason
    };
  }
}

async function refreshDouyinHotlistAccounts(
  accounts: Account[],
  window: HotlistWindow,
  limit: number,
  concurrency: number,
  signal?: AbortSignal,
  onResult?: (result: DouyinHotlistRefreshAccountResult) => void | Promise<void>
): Promise<DouyinHotlistRefreshAccountResult[]> {
  if (accounts.length <= 1) {
    return mapWithConcurrency(accounts, concurrency, async (account) => {
      const result = await refreshDouyinHotlistAccount(account, window, limit, signal);
      await onResult?.(result);
      return result;
    });
  }

  const results = new Array<DouyinHotlistRefreshAccountResult>(accounts.length);
  const douyinEntries = accounts
    .map((account, index) => ({ account, index }))
    .filter((entry) => entry.account.platform === "douyin");
  const singleEntries = accounts
    .map((account, index) => ({ account, index }))
    .filter((entry) => entry.account.platform !== "douyin" || douyinEntries.length <= 1);

  if (singleEntries.length) {
    const singleResults = await mapWithConcurrency(
      singleEntries,
      concurrency,
      async ({ account }) => {
        const result = await refreshDouyinHotlistAccount(account, window, limit, signal);
        await onResult?.(result);
        return result;
      }
    );
    singleResults.forEach((result, index) => {
      results[singleEntries[index].index] = result;
    });
  }

  if (douyinEntries.length <= 1) {
    return results.map((result, index) => result || {
      accountId: accounts[index].id,
      error: "视频热榜刷新没有返回这个账号的结果。",
      mode: "single",
      name: accounts[index].name,
      status: "failed"
    });
  }

  throwIfAborted(signal);
  await collectDouyinPostVideosBatch({
    accounts: douyinEntries.map((entry) => entry.account),
    concurrency,
    fromDate: window.fromDate,
    limit,
    signal,
    toDate: window.toDate,
    onResult: async (batchResult) => {
      throwIfAborted(signal);
      const resultIndex = douyinEntries.find((entry) => entry.account.id === batchResult.account.id)!.index;
      if (batchResult.status === "failed") {
        results[resultIndex] = {
          accountId: batchResult.account.id,
          error: batchResult.error || "抖音批量抓取失败，已跳过单账号重试。",
          mode: "batch",
          name: batchResult.account.name,
          rawCount: batchResult.rawCount,
          status: "failed"
        };
        await onResult?.(results[resultIndex]);
        return;
      }

      results[resultIndex] = await saveDouyinHotlistRefreshResult(batchResult.account, batchResult.videos, batchResult.rawCount, {
        mode: "batch",
        raw: batchResult.raw
      });
      await onResult?.(results[resultIndex]);
    }
  });

  return results.map((result, index) => result || {
    accountId: accounts[index].id,
    error: "视频热榜刷新没有返回这个账号的结果，且未进入重试。",
    mode: "batch",
    name: accounts[index].name,
    status: "failed"
  });
}

async function saveDouyinHotlistRefreshResult(
  account: Account,
  videos: Video[],
  rawCount: number,
  options: Pick<DouyinHotlistRefreshAccountResult, "mode" | "retried" | "retryReason"> & { raw?: unknown } = {}
): Promise<DouyinHotlistRefreshAccountResult> {
  if (!videos.length) {
    return {
      accountId: account.id,
      error: `${formatPlatformName(account.platform)}账号在当前窗口没有可用新视频，内容未更新。`,
      mode: options.mode,
      name: account.name,
      rawCount,
      retried: options.retried || undefined,
      retryReason: options.retryReason,
      savedCount: 0,
      status: "unchanged"
    };
  }

  const saved = await withDouyinHotlistMutationLock(async () => {
    const inferredAvatarUrl = account.avatarUrl || inferAccountAvatarFromCollectedData(videos, options.raw);
    const updatedAccount = await upsertDouyinHotlistAccount({
      platform: account.platform,
      name: account.name,
      uid: account.uid,
      sourceUrl: account.sourceUrl,
      avatarUrl: inferredAvatarUrl,
      lastCollectedAt: nowIso()
    });
    const writeResult = await saveDouyinHotlistVideos(updatedAccount, videos);
    return { account: updatedAccount, ...writeResult };
  });
  return {
    accountId: saved.account.id,
    mode: options.mode,
    name: saved.account.name,
    rawCount,
    retried: options.retried || undefined,
    retryReason: options.retryReason,
    savedCount: saved.changedCount,
    observedCount: saved.observedCount,
    changedCount: saved.changedCount,
    status: saved.changedCount > 0 ? "completed" : "unchanged"
  };
}

async function resolveWatchlistAccounts(accountIds: string[]) {
  const entries = await Promise.all(
    accountIds.map(async (accountId) => ({
      accountId,
      account: await resolveDouyinHotlistAccount(accountId)
    }))
  );

  return {
    accounts: entries.map((entry) => entry.account).filter((account): account is Account => Boolean(account)),
    staleAccountIds: entries.filter((entry) => !entry.account).map((entry) => entry.accountId)
  };
}

function resolveAccountTarget(platform: Platform, query: string) {
  const raw = query.replace(/\s+/g, " ").trim();
  if (!raw) {
    throw new Error(`请输入${formatPlatformName(platform)}账号名、主页链接或 ${platform === "douyin" ? "sec_uid" : "UID"}。`);
  }

  const link = extractPlatformAccountLink(platform, raw);
  const idToken = extractPlatformAccountIdToken(platform, raw);
  const uidOrUrl = link || idToken || undefined;
  const label = uidOrUrl ? removeAccountReference(platform, raw, uidOrUrl) : raw;
  const displayName = label || `${formatPlatformName(platform)}账号 ${shortHash(uidOrUrl || raw)}`;

  return {
    lookupName: label || raw,
    uidOrUrl,
    sourceUrl: uidOrUrl || raw,
    displayName
  };
}

function extractPlatformAccountLink(platform: Platform, input: string) {
  return extractLinksFromInput(input, { kind: "account" }).find((link) => isPlatformAccountLink(platform, link.url))?.url || "";
}

function extractPlatformAccountIdToken(platform: Platform, input: string) {
  const token = input.trim();
  if (platform === "bilibili" && BILIBILI_UID_PATTERN.test(token)) return token;
  if (platform === "douyin") return token.match(DOUYIN_SEC_UID_PATTERN)?.[0] || "";
  return "";
}

function isPlatformAccountLink(platform: Platform, input: string) {
  try {
    const parsed = new URL(addHttpScheme(input));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    if (platform === "bilibili") {
      return host.endsWith("bilibili.com") && /^\/\d+/.test(pathname);
    }

    return (
      /(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host)
    ) && (/\/(?:user|share\/user)\//i.test(pathname) || parsed.searchParams.has("sec_uid"));
  } catch {
    return false;
  }
}

function addHttpScheme(input: string) {
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

function removeAccountReference(platform: Platform, input: string, reference: string) {
  const platformPattern = platform === "bilibili"
    ? /(?:https?:\/\/)?(?:space\.)?bilibili\.com\/\S+/gi
    : /(?:https?:\/\/)?(?:www\.)?(?:douyin|iesdouyin)\.com\/\S+/gi;

  return input
    .replace(reference, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(platformPattern, "")
    .replace(platform === "douyin" ? DOUYIN_SEC_UID_PATTERN : BILIBILI_UID_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getHotlistCollectOrder(platform: Platform) {
  return platform === "bilibili" ? "pubdate" : "likes";
}

function formatPlatformName(platform: Platform) {
  return platform === "bilibili" ? "B站" : "抖音";
}

function resolveHotlistWindow(windowInput?: number | string): HotlistWindow {
  const now = new Date();
  const windowKey = normalizeHotlistWindowKey(windowInput);
  const preset = getHotlistWindowPreset(windowKey);
  const from = resolveHotlistWindowStart(now, preset);
  const fromDate = toDateInputValue(from);
  const toDate = toDateInputValue(now);

  return {
    windowKey,
    label: preset.label,
    windowDays: Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 86_400_000)),
    windowHours: preset.hours,
    fromDate,
    toDate,
    fromTime: from.getTime(),
    toTime: now.getTime()
  };
}

type HotlistWindowPreset = {
  key: string;
  label: string;
  hours?: number;
  days?: number;
};

const HOTLIST_WINDOW_PRESETS: HotlistWindowPreset[] = [
  { key: "3h", label: "近 3 小时", hours: 3 },
  { key: "6h", label: "近 6 小时", hours: 6 },
  { key: "12h", label: "近 12 小时", hours: 12 },
  { key: "24h", label: "近 24 小时", hours: 24 },
  { key: "3d", label: "近 3 天", days: 3 }
];

function normalizeHotlistWindowKey(input?: number | string) {
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (HOTLIST_WINDOW_PRESETS.some((preset) => preset.key === normalized)) return normalized;
    const dayMatch = normalized.match(/^(\d+)d$/);
    if (dayMatch) {
      const days = clampInteger(Number(dayMatch[1]), 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
      return days === DEFAULT_WINDOW_DAYS ? DEFAULT_WINDOW_KEY : `${days}d`;
    }
  }

  if (typeof input === "number" && Number.isFinite(input)) {
    const days = clampInteger(input, 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
    return days === DEFAULT_WINDOW_DAYS ? DEFAULT_WINDOW_KEY : `${days}d`;
  }

  return DEFAULT_WINDOW_KEY;
}

function getHotlistWindowPreset(windowKey: string): HotlistWindowPreset {
  const preset = HOTLIST_WINDOW_PRESETS.find((item) => item.key === windowKey);
  if (preset) return preset;

  const dayMatch = windowKey.match(/^(\d+)d$/);
  const days = dayMatch ? clampInteger(Number(dayMatch[1]), 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS) : DEFAULT_WINDOW_DAYS;
  return {
    key: `${days}d`,
    label: `近 ${days} 天`,
    days
  };
}

function resolveHotlistWindowStart(now: Date, preset: HotlistWindowPreset) {
  const from = new Date(now);
  if (preset.hours) {
    from.setHours(from.getHours() - preset.hours);
    return from;
  }

  from.setDate(from.getDate() - (preset.days || DEFAULT_WINDOW_DAYS));
  return from;
}

type HotlistRankItemDraft = Omit<DouyinHotlistItem, "surge"> & {
  surgeState?: VideoHotlistSurgeState;
  trend?: VideoHotlistTrend;
};

function buildRankItem(
  account: Account,
  video: Video,
  window: HotlistWindow
): HotlistRankItemDraft {
  const ageHours = getVideoAgeHours(video);
  const windowHours = window.windowHours || window.windowDays * 24;
  const heatScore = calculateHotlistRankScore(video, ageHours, windowHours);
  const listVideo = toHotlistVideo(video);

  return {
    rank: 0,
    account: {
      id: account.id,
      platform: account.platform,
      name: account.name,
      uid: account.uid,
      avatarUrl: account.avatarUrl
    },
    video: {
      ...listVideo,
      title: stripTitleTags(listVideo.title)
    },
    heatScore,
    ageHours,
    tags: extractTags(video.title),
    signal: describeContentSignal(video, ageHours, window.label),
    surgeState: video.hotlistSurge,
    trend: video.hotlistTrend
  };
}

function shouldShowHotlistRankItem(item: HotlistRankItemDraft) {
  return (
    item.ageHours === undefined ||
    item.ageHours <= STALE_LOW_HEAT_MAX_AGE_HOURS ||
    item.heatScore >= STALE_LOW_HEAT_MIN_SCORE
  );
}

function finalizeRankItem(
  item: HotlistRankItemDraft,
  index: number
): DouyinHotlistItem {
  const rank = index + 1;
  const surge = buildSurgeHighlight(item, rank);

  return {
    account: item.account,
    video: item.video,
    heatScore: item.heatScore,
    ageHours: item.ageHours,
    tags: item.tags,
    signal: item.signal,
    rank,
    ...(surge ? { surge } : {})
  };
}

function buildSurgeHighlight(
  item: HotlistRankItemDraft,
  rank: number
): DouyinHotlistSurgeHighlight | undefined {
  if (!isHotlistSurgeEligible({
    ageHours: item.ageHours,
    hotScore: item.video.hotScore,
    platform: item.video.platform,
    stats: item.video.stats
  })) {
    return undefined;
  }

  const currentDecision = getHotlistSurgeDecision(item.trend, item.video.platform);
  if (currentDecision) {
    return {
      label: getHotlistSurgeLabel(rank, currentDecision.heatPerHour, currentDecision.minHeatPerHour),
      reason: formatHotlistSurgeReason(currentDecision),
      heatDelta: currentDecision.heatDelta,
      heatPerHour: currentDecision.heatPerHour,
      intervalHours: currentDecision.intervalHours
    };
  }

  if (!shouldRetainHotlistSurgeState(item.video.platform)) return undefined;

  const surgeState = item.surgeState;
  if (
    !isHotlistSurgeActive(surgeState) ||
    !isHotlistSurgeStateAboveThreshold(surgeState, item.video.platform)
  ) {
    return undefined;
  }

  return {
    label: getHotlistSurgeLabel(
      rank,
      surgeState.heatPerHour,
      getSurgeMinHeatPerHour(Math.max(0.25, surgeState.intervalHours), item.video.platform)
    ),
    reason: formatHotlistSurgeReason(surgeState),
    heatDelta: surgeState.heatDelta,
    heatPerHour: surgeState.heatPerHour,
    intervalHours: surgeState.intervalHours
  };
}

function stripTitleTags(title: string) {
  return title
    .replace(/#[^\s#，。！？、；;,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || title;
}

function describeContentSignal(video: Video, ageHours: number | undefined, windowLabel: string) {
  const likes = video.stats.likes;
  const comments = video.stats.comments;
  const savesAndShares = video.stats.favorites + (video.stats.shares ?? 0);
  const velocity = calculateHotlistVelocity(calculateHotlistInteractionHeat(video.stats), ageHours);

  if (isExplosiveVelocity(video, velocity, ageHours)) {
    return `${formatCompactCount(likes)}赞/${formatSignalAge(ageHours)}，正在跑量`;
  }
  if (isFastRisingVelocity(video, velocity, ageHours)) {
    return "短时起量，优先跟进";
  }

  if (ageHours !== undefined && ageHours <= 12 && likes + comments + savesAndShares > 0) {
    return "新发酵，适合快速跟进";
  }
  if (comments >= 20 && comments >= likes * 0.08) {
    return "评论强，优先拆争议点";
  }
  if (savesAndShares >= 20 && savesAndShares >= likes * 0.3) {
    return "收藏/分享强，适合做实用选题";
  }
  if (likes >= 1000) {
    return "点赞高，适合复盘结构";
  }
  return `进入${windowLabel}样本，适合观察切入`;
}

function isExplosiveVelocity(
  video: Video,
  velocity: ReturnType<typeof calculateHotlistVelocity>,
  ageHours?: number
) {
  return (
    ageHours !== undefined &&
    ageHours <= EXPLOSIVE_MAX_AGE_HOURS &&
    video.stats.likes >= EXPLOSIVE_MIN_LIKES &&
    velocity.heatPerHour >= EXPLOSIVE_MIN_HEAT_PER_HOUR
  );
}

function isFastRisingVelocity(
  video: Video,
  velocity: ReturnType<typeof calculateHotlistVelocity>,
  ageHours?: number
) {
  return (
    ageHours !== undefined &&
    ageHours <= FAST_RISING_MAX_AGE_HOURS &&
    video.stats.likes >= FAST_RISING_MIN_LIKES &&
    velocity.heatPerHour >= FAST_RISING_MIN_HEAT_PER_HOUR
  );
}

function formatCompactCount(value: number) {
  if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function formatSignalAge(ageHours?: number) {
  if (ageHours === undefined || ageHours < 1) return "1h内";
  return `${Math.max(1, Math.round(ageHours))}h`;
}

function toHotlistVideo(video: Video): DouyinHotlistItem["video"] {
  return {
    id: video.id,
    platform: video.platform,
    title: video.title,
    url: video.url,
    coverUrl: video.coverUrl,
    publishedAt: video.publishedAt,
    stats: video.stats,
    hotScore: video.hotScore
  };
}

function isVideoInWindow(video: Video, window: HotlistWindow) {
  const publishedAt = getPublishedTime(video);
  return publishedAt !== null && publishedAt >= window.fromTime && publishedAt <= window.toTime;
}

function comparePublishedAtDesc(left: Pick<Video, "publishedAt">, right: Pick<Video, "publishedAt">) {
  return (getPublishedTime(right) ?? 0) - (getPublishedTime(left) ?? 0);
}

function getVideoAgeHours(video: Pick<Video, "publishedAt">) {
  const publishedAt = getPublishedTime(video);
  if (publishedAt === null) return undefined;
  const ageMs = Date.now() - publishedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  return Math.round(ageMs / 36_000) / 100;
}

function getPublishedTime(video: Pick<Video, "publishedAt">) {
  if (!video.publishedAt) return null;
  const time = new Date(video.publishedAt).getTime();
  return Number.isFinite(time) ? time : null;
}

function extractTags(title: string) {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const match of title.matchAll(/#[^\s#，。！？、；;,.!?]+/g)) {
    const tag = match[0];
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 4) break;
  }

  return tags;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function uniqueAccountIds(accountIds: string[]) {
  return [...new Set(accountIds.map((accountId) => accountId.trim()).filter(Boolean))];
}

function hasSameAccountIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((accountId) => rightIds.has(accountId));
}

function resolveRefreshConcurrency(accountCount: number) {
  if (accountCount <= 1) return 1;
  const parsed = Number.parseInt(process.env.DOUYIN_HOTLIST_REFRESH_CONCURRENCY || "", 10);
  const fallback = DEFAULT_REFRESH_CONCURRENCY;
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(accountCount, Math.max(1, Math.min(value, MAX_REFRESH_CONCURRENCY)));
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("任务已停止");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /aborted|任务已停止/i.test(error.message));
}
