import { inferAccountAvatarFromCollectedData, inferAccountNameFromCollectedData, resolveAccountProfile } from "./account-profile";
import { collectVideos, hydrateDouyinVideoStatsBatch, resolveAccountUid } from "./opencli";
import { findAccountByName, getAccountSummary, saveVideos, upsertAccount } from "./storage";
import type { Account, CollectOrder, CollectResult, Platform, Video } from "./types";
import { extractFirstLinkFromInput, normalizeLinkInput } from "./platform-links";
import { nowIso, shortHash } from "./utils";

const BILIBILI_CANDIDATE_LIMIT = 50;
const DOUYIN_CANDIDATE_LIMIT = 120;
const MIN_LOCAL_SORT_CANDIDATE_LIMIT = 20;
const MAX_DATE_FILTER_PAGES = 8;
const bilibiliCollectOrders = ["views", "likes", "favorites", "comments", "pubdate"] as const;
const douyinCollectOrders = ["likes", "comments", "pubdate"] as const;

export type CollectAccountInput = {
  platform: Platform;
  name: string;
  uidOrUrl?: string;
  limit: number;
  order: CollectOrder | "like" | "click" | "stow";
  fromDate?: string;
  toDate?: string;
};

export function applyDefaultCollectionDateRange(input: CollectAccountInput, today = new Date()): CollectAccountInput {
  if (input.platform !== "douyin" || input.fromDate || input.toDate) return input;
  const year = today.getFullYear();
  const month = today.getMonth();
  const day = today.getDate();
  // 按日历年回溯；闰日回溯到非闰年时取二月最后一天。
  const from = new Date(year - 5, month, Math.min(day, new Date(year - 5, month + 1, 0).getDate()));
  const format = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { ...input, fromDate: format(from), toDate: format(today) };
}

export async function collectAccountContent(
  input: CollectAccountInput,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: { stage: string; message: string; progress: number }) => void | Promise<void>;
  } = {}
): Promise<CollectResult> {
  input = applyDefaultCollectionDateRange(input);
  await options.onProgress?.({ stage: "resolve-account", message: "正在识别账号主页", progress: 10 });
  const target = resolveCollectTarget(input.platform, input.name, input.uidOrUrl);
  const order = normalizeCollectOrder(input.order);
  validateCollectOrder(input.platform, order);
  const existing = !target.uidOrUrl ? await findAccountByName(input.platform, target.lookupName) : null;
  const uid =
    existing?.uid ||
    (await resolveAccountUid(input.platform, target.lookupName, target.uidOrUrl, { signal: options.signal }));
  throwIfAborted(options.signal);
  const collectAccount = existing || makeTransientAccount(input.platform, target.displayNameFallback, uid, target.sourceUrl);

  await options.onProgress?.({ stage: "collect", message: "正在采集视频列表", progress: 28 });
  const collectPlan = makeCollectPlan(input.platform, input.limit, order, input.fromDate, input.toDate);
  const result = await collectVideos({
    platform: input.platform,
    account: collectAccount,
    limit: collectPlan.limit,
    order: collectPlan.order,
    hydrateDetails: collectPlan.hydrateDetails,
    fromDate: input.platform === "douyin" ? input.fromDate : undefined,
    toDate: input.platform === "douyin" ? input.toDate : undefined,
    signal: options.signal
  });
  if (collectPlan.pageByPubdate && input.platform === "bilibili") {
    await options.onProgress?.({ stage: "date-window", message: "正在补齐日期范围内的视频", progress: 52 });
    result.videos = await collectDateWindowCandidates({
      account: collectAccount,
      fromDate: input.fromDate,
      toDate: input.toDate,
      firstPageVideos: result.videos,
      hydrateDetails: collectPlan.hydrateDetails,
      signal: options.signal
    });
    result.rawCount = result.videos.length;
  }
  if (input.platform === "douyin" && result.videos.length) {
    await options.onProgress?.({ stage: "hydrate-details", message: "正在补全发布日期和互动数据", progress: 56 });
    try {
      result.videos = await hydrateDouyinVideoStatsBatch(result.videos, { signal: options.signal });
    } catch (error) {
      throwIfAborted(options.signal);
      const message = error instanceof Error ? error.message : "抖音详情接口请求失败";
      result.videos = result.videos.map((video) => ({
        ...video,
        statsHydration: {
          status: "failed",
          source: "opencli",
          checkedAt: nowIso(),
          missingFields: video.statsHydration?.missingFields || ["comments", "favorites", "shares"],
          error: message
        }
      }));
    }
  }

  throwIfAborted(options.signal);
  await options.onProgress?.({ stage: "profile", message: "正在补全账号资料", progress: 68 });
  const accountName = inferAccountNameFromCollectedData(
    input.platform,
    result.raw,
    target.displayNameFallback || existing?.name || uid
  );
  const inferredAvatarUrl = inferAccountAvatarFromCollectedData(result.videos, result.raw);
  const profile = inferredAvatarUrl ? null : await resolveAccountProfile({
    platform: input.platform,
    uid,
    fallbackName: accountName,
    sourceUrl: target.sourceUrl,
    signal: options.signal
  });
  const updatedAccount = await upsertAccount({
    platform: input.platform,
    name: profile?.name || accountName,
    uid,
    sourceUrl: profile?.sourceUrl || target.sourceUrl,
    avatarUrl: inferredAvatarUrl || profile?.avatarUrl,
    lastCollectedAt: nowIso()
  });

  await options.onProgress?.({ stage: "save", message: "正在筛选并写入账号库", progress: 84 });
  const dateFilter = buildDateFilterResult(result.videos, input.fromDate, input.toDate);
  const filteredVideos = selectVideosForSave({
    videos: dateFilter.filteredVideos,
    limit: input.limit,
    order
  });
  throwIfAborted(options.signal);
  const videos = sortVideos(await saveVideos(updatedAccount, filteredVideos), order);

  return {
    account: await getAccountSummary(updatedAccount),
    videos,
    command: result.command,
    rawCount: result.rawCount,
    filteredCount: filteredVideos.length,
    dateFilter: dateFilter.summary
  };
}

type LegacyCollectOrder = CollectOrder | "like" | "click" | "stow";

function resolveCollectTarget(platform: Platform, name: string, uidOrUrl?: string) {
  const lookupName = name.trim();
  const explicitField = uidOrUrl ? normalizeLinkInput(uidOrUrl, { kind: "account" }) : "";
  const inlineReference = explicitField ? "" : extractInlineAccountReference(platform, lookupName);
  const explicit = explicitField || inlineReference;
  const inlineLabel = inlineReference ? removeInlineReferenceLabel(lookupName) : "";

  return {
    lookupName,
    uidOrUrl: explicit,
    sourceUrl: explicit || lookupName,
    displayNameFallback: explicit
      ? inlineLabel || (explicitField && lookupName ? lookupName : fallbackAccountName(platform, explicit))
      : lookupName
  };
}

function extractInlineAccountReference(platform: Platform, input: string) {
  const link = extractFirstLinkFromInput(input, { kind: "account" });
  if (link && isPlatformAccountProfileUrl(platform, link)) {
    return normalizeLinkInput(link, { kind: "account" });
  }

  const token = input.trim();
  if (platform === "bilibili" && /^\d{4,}$/.test(token)) return token;
  if (platform === "douyin" && /^MS4wLjAB[0-9A-Za-z_.-]{20,}$/.test(token)) return token;
  return "";
}

function isPlatformAccountProfileUrl(platform: Platform, input: string) {
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

function removeInlineReferenceLabel(input: string) {
  const link = extractFirstLinkFromInput(input, { kind: "account" });
  if (!link) return "";
  return input
    .replace(link, "")
    .replace(/https?:\/\/\S+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackAccountName(platform: Platform, uidOrUrl: string) {
  return `${platform === "bilibili" ? "B站账号" : "抖音账号"} ${shortHash(uidOrUrl)}`;
}

function makeTransientAccount(platform: Platform, name: string, uid: string, sourceUrl: string): Account {
  const slug = `${platform}-${shortHash(uid)}`;
  const now = nowIso();
  return {
    id: `${platform}:${slug}`,
    slug,
    platform,
    name,
    uid,
    sourceUrl,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeCollectOrder(order: LegacyCollectOrder): CollectOrder {
  if (order === "click") return "views";
  if (order === "stow") return "favorites";
  if (order === "like") return "likes";
  return order;
}

function validateCollectOrder(platform: Platform, order: CollectOrder) {
  const allowedOrders = platform === "bilibili" ? bilibiliCollectOrders : douyinCollectOrders;
  if ((allowedOrders as readonly CollectOrder[]).includes(order)) return;
  const readable = platform === "bilibili" ? "播放、点赞、收藏、评论、时间" : "点赞、评论、时间";
  throw new Error(`${platform === "bilibili" ? "B站" : "抖音"}只支持按${readable}筛选。`);
}

function makeCollectPlan(
  platform: Platform,
  limit: number,
  order: CollectOrder,
  fromDate?: string,
  toDate?: string
): {
  limit: number;
  order: CollectOrder;
  pageByPubdate: boolean;
  hydrateDetails: boolean;
} {
  const hasDateFilter = Boolean(fromDate || toDate);
  const needsLocalMetricSort = order === "likes" || order === "comments" || order === "favorites";
  return {
    limit: platform === "bilibili" && hasDateFilter ? BILIBILI_CANDIDATE_LIMIT : needsLocalMetricSort ? localSortCandidateLimit(platform, limit) : limit,
    order: platform === "douyin" ? order : hasDateFilter ? "pubdate" : getCollectionOrder(order),
    pageByPubdate: platform === "bilibili" && hasDateFilter,
    hydrateDetails: platform === "bilibili" && (order === "comments" || order === "favorites")
  };
}

function localSortCandidateLimit(platform: Platform, limit: number) {
  const cap = platform === "douyin" ? DOUYIN_CANDIDATE_LIMIT : BILIBILI_CANDIDATE_LIMIT;
  return Math.min(cap, Math.max(limit, limit * 2, MIN_LOCAL_SORT_CANDIDATE_LIMIT));
}

function getCollectionOrder(order: CollectOrder): CollectOrder {
  if (order === "favorites") return "favorites";
  if (order === "pubdate") return "pubdate";
  return "views";
}

async function collectDateWindowCandidates(input: {
  account: Parameters<typeof collectVideos>[0]["account"];
  fromDate?: string;
  toDate?: string;
  firstPageVideos: Video[];
  hydrateDetails: boolean;
  signal?: AbortSignal;
}) {
  const from = parseBoundaryDate(input.fromDate, "start");
  const to = parseBoundaryDate(input.toDate, "end");
  const videos = [...input.firstPageVideos];

  for (let page = 2; page <= MAX_DATE_FILTER_PAGES; page += 1) {
    if (shouldStopPaging(videos, from, to)) break;
    const nextPage = await collectVideos({
      platform: "bilibili",
      account: input.account,
      limit: BILIBILI_CANDIDATE_LIMIT,
      order: "pubdate",
      page,
      hydrateDetails: input.hydrateDetails,
      signal: input.signal
    });
    if (!nextPage.videos.length) break;
    videos.push(...nextPage.videos);
  }

  return dedupeVideos(videos);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("请求已取消");
  error.name = "AbortError";
  throw error;
}

function selectVideosForSave(input: {
  videos: Video[];
  limit: number;
  order: CollectOrder;
}) {
  return sortVideos(input.videos, input.order).slice(0, input.limit);
}

function shouldStopPaging(videos: Video[], from: Date | null, to: Date | null) {
  const dated = videos.map((video) => parsePublishedAt(video.publishedAt)).filter((date): date is Date => Boolean(date));
  if (!dated.length) return false;
  const oldest = dated.reduce((min, date) => (date < min ? date : min), dated[0]);
  if (!from) return false;
  const hasCandidateInWindow = !to || dated.some((date) => date <= to);
  return hasCandidateInWindow && oldest < from;
}

function dedupeVideos(videos: Video[]) {
  const seen = new Set<string>();
  return videos.filter((video) => {
    const key = video.id || video.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildDateFilterResult(videos: Video[], fromDate?: string, toDate?: string) {
  const from = parseBoundaryDate(fromDate, "start");
  const to = parseBoundaryDate(toDate, "end");
  const datedVideos = videos
    .map((video) => ({ video, publishedAt: parsePublishedAt(video.publishedAt) }))
    .filter((item): item is { video: Video; publishedAt: Date } => Boolean(item.publishedAt));

  if (!from && !to) {
    return {
      filteredVideos: videos,
      summary: {
        applied: false,
        rawCount: videos.length,
        matchedCount: videos.length,
        filteredOutCount: 0,
        missingDateCount: videos.length - datedVideos.length,
        ...dateSpan(datedVideos.map((item) => item.publishedAt))
      }
    };
  }

  const filteredVideos = datedVideos
    .filter(({ publishedAt }) => {
      if (from && publishedAt < from) return false;
      if (to && publishedAt > to) return false;
      return true;
    })
    .map(({ video }) => video);

  return {
    filteredVideos,
    summary: {
      applied: true,
      fromDate,
      toDate,
      rawCount: videos.length,
      matchedCount: filteredVideos.length,
      filteredOutCount: videos.length - filteredVideos.length,
      missingDateCount: videos.length - datedVideos.length,
      ...dateSpan(datedVideos.map((item) => item.publishedAt))
    }
  };
}

function sortVideos(videos: Video[], order: CollectOrder) {
  const sorted = [...videos];
  if (order === "pubdate") {
    return sorted.sort((a, b) => compareDates(b.publishedAt, a.publishedAt) || compareByMetric(b, a, "likes"));
  }
  return sorted.sort(
    (a, b) =>
      compareByMetric(b, a, order) ||
      compareByMetric(b, a, "views") ||
      compareByMetric(b, a, "likes") ||
      compareDates(b.publishedAt, a.publishedAt)
  );
}

function compareByMetric(a: Video, b: Video, order: CollectOrder) {
  if (order === "pubdate") return compareDates(a.publishedAt, b.publishedAt);
  return statValue(a, order) - statValue(b, order);
}

function statValue(video: Video, order: Exclude<CollectOrder, "pubdate">) {
  if (order === "views") return video.stats.views;
  if (order === "likes") return video.stats.likes;
  if (order === "favorites") return video.stats.favorites;
  return video.stats.comments;
}

function compareDates(a?: string, b?: string) {
  return (parsePublishedAt(a)?.getTime() || 0) - (parsePublishedAt(b)?.getTime() || 0);
}

function parseBoundaryDate(value: string | undefined, boundary: "start" | "end") {
  if (!value) return null;
  const date = new Date(`${value}T${boundary === "start" ? "00:00:00" : "23:59:59"}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parsePublishedAt(value: string | undefined) {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;

  const dateOnly = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
  }

  const date = new Date(normalized.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateSpan(dates: Date[]) {
  if (!dates.length) return {};
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  return {
    earliestPublishedAt: toDateInputValue(sorted[0]),
    latestPublishedAt: toDateInputValue(sorted[sorted.length - 1])
  };
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
