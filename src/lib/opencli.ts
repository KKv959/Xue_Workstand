import { getDouyinSingleVideoReference } from "./opencli-douyin-detail";
import { SOURCE_VIDEO_COMMENT_THRESHOLD, selectEligibleCommentSources, sourceCommentCount, collectCommentSources, type CommentCollectionAttempt, type CommentCollectionBudget, type CommentPageTrace } from "./engagement-source-selection";
import { Account, CollectOrder, Platform, Video } from "./types";
import {
  asArray,
  buildOpenCliBrowserArgs,
  mergeTimingMeta,
  opencliBin,
  openCliRows,
  parseJsonish,
  parseOpenCliJsonish,
  retryDetachedBrowserRead,
  resolveOpenCliCommand,
  runOpenCli,
  runPersistentOpenCliBrowserAdapter,
  sharedOpenCliBrowserSession,
  stringField,
  timeOpenCliOperation,
  withSharedOpenCliBrowserSession,
  withTimingMeta,
  type OpenCliTimingEntry,
  type OpenCliTimingMeta,
  type OpenCliTimingOptions,
  type OpenCliTimingSink
} from "./opencli-runtime";
import {
  buildDouyinVideoUrl,
  extractBilibiliUid,
  extractDouyinAwemeId,
  extractDouyinSecUid,
  getVideoComparableKey,
  isLikelyDirectMediaUrl
} from "./platform-links";
import { nowIso, safeSegment, shortHash, toNumber } from "./utils";
import {
  containsPlatformUserMention,
  firstNumber,
  isExcludedRelatedVideo,
  selectRelatedCommentVideos,
  normalizeCommentText,
  normalizeTimestamp,
  uniqueStrings
} from "./opencli-normalizers";
import { collectBilibiliVideos, searchBilibiliUserUid } from "./opencli-bilibili";
import { getDouyinAccessError, pausedDouyinRefreshError } from "./douyin-access-errors";
import {
  DOUYIN_AWEME_ID_EXTRACT_JS,
  DOUYIN_MEDIA_EXTRACT_JS,
  DOUYIN_SEARCH_EXTRACT_JS,
  buildDouyinBatchStatsExtractJs,
  buildDouyinCommentCountsJs,
  buildDouyinBatchPostExtractJs,
  buildDouyinCommentsExtractJs,
  buildDouyinDetailExtractJs,
  buildDouyinStatsExtractJs
} from "./opencli-douyin-scripts";

const DOUYIN_USER_VIDEOS_LIMIT = 20;
const DOUYIN_RELATED_COMMENT_VIDEO_LIMIT = 6;
const DOUYIN_RELATED_COMMENT_PER_VIDEO_LIMIT = 20;
// 与 B站一致：搜索结果的评论数是占位值，按排名每次批量核验一组。
const DOUYIN_COMMENT_COUNT_BATCH_SIZE = 4;

type DouyinMediaLookupOptions = {
  limit?: number;
  signal?: AbortSignal;
};
type VideoStatsTimingOptions = OpenCliTimingOptions;
type DouyinDetailStatField = "likes" | "comments" | "favorites" | "shares";
const DOUYIN_DETAIL_STAT_FIELDS: DouyinDetailStatField[] = ["likes", "comments", "favorites", "shares"];

export type DouyinBatchVideoCollectResult = {
  account: Account;
  status: "completed" | "failed";
  rawCount: number;
  raw: unknown[];
  videos: Video[];
  error?: string;
};

export type { OpenCliTimingEntry, OpenCliTimingMeta, OpenCliTimingSink };
export {
  buildOpenCliBrowserArgs,
  openCliRows,
  parseOpenCliJsonish,
  resolveOpenCliCommand
};
export {
  downloadBilibiliVideo,
  getBilibiliComments,
  getBilibiliRelatedTopicComments,
  getBilibiliSubtitle,
  getBilibiliPublicVideoReference,
  getBilibiliVideoReference,
  getBilibiliVideoStatsByUrl,
  hydrateBilibiliVideoStats
} from "./opencli-bilibili";
export type {
  BilibiliCommentSample,
  BilibiliRelatedCommentResult,
  BilibiliRelatedCommentVideo,
  BilibiliVideoReference,
  BilibiliVideoStatsResult
} from "./opencli-bilibili";

export type DouyinRelatedCommentVideo = {
  id: string;
  commentCount?: number;
  query?: string;
  title: string;
  author?: string;
  likes: number;
  publishedAt?: string;
  url: string;
};

export type DouyinRelatedCommentSample = {
  text: string;
  likes: number;
  replies: number;
  videoId: string;
  videoTitle: string;
};

export type DouyinRelatedCommentResult = {
  collectionAttempts?: CommentCollectionAttempt[];
  query: string;
  videos: DouyinRelatedCommentVideo[];
  comments: string[];
  commentSamples: DouyinRelatedCommentSample[];
  appliedMinLikes: number;
  errors?: string[];
};

export type DouyinCommentSample = { text: string; likes: number; replies: number };
type DouyinCommentRows = {
  pageTrace: CommentPageTrace[];
  stopReason: CommentCollectionAttempt["stopReason"];
  awemeId: string;
  comments: DouyinCommentSample[];
  pages: number;
  hasMore: boolean;
  ms: number;
  error?: string;
};

type DouyinVideoStatsSnapshot = {
  missingFields?: DouyinDetailStatField[];
  title: string;
  likeCount: number;
  commentCount: number;
  favoriteCount: number;
  shareCount: number;
  publishedAt?: string;
  authorName?: string;
  authorSecUid?: string;
};

type DouyinVideoStatsResult = {
  platform: "douyin";
  title: string;
  url: string;
  videoKey: string;
  publishedAt?: string;
  authorName?: string;
  authorSecUid?: string;
  stats: {
    like: number;
    comment: number;
    favorite: number;
    share: number;
  };
};

// 详情接口依赖网页安全 SDK 和 UIFID；robots.txt 不加载 SDK，会返回 403。
const DOUYIN_STATS_HOME_URL = "https://www.douyin.com/";

export function normalizeAccountInput(platform: Platform, uidOrUrl: string) {
  return platform === "bilibili" ? extractBilibiliUid(uidOrUrl) : extractDouyinSecUid(uidOrUrl);
}

export async function resolveAccountUid(
  platform: Platform,
  name: string,
  uidOrUrl?: string,
  options: { signal?: AbortSignal } = {}
) {
  const explicit = uidOrUrl?.trim();
  if (explicit) return normalizeAccountInput(platform, explicit);

  if (platform === "bilibili") {
    return searchBilibiliUserUid(name, { signal: options.signal });
  }

  return searchDouyinUserSecUidWithBrowser(name, { signal: options.signal });
}

async function searchDouyinUserSecUidWithBrowser(name: string, options: { signal?: AbortSignal } = {}) {
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(name)}?type=user`;

  return withSharedOpenCliBrowserSession(async (workspace) => {
    try {
      const openResult = parseJsonish(
        await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [searchUrl], { window: "background" }), {
          timeout: 30_000,
          signal: options.signal
        })
      );
      const tab = openResult && typeof openResult === "object" ? String((openResult as Record<string, unknown>).page || "") : "";
      const evalArgs = buildOpenCliBrowserArgs(workspace, "eval", [DOUYIN_SEARCH_EXTRACT_JS], tab ? { tab } : {});
      const rows = asArray(parseJsonish(await runOpenCli(evalArgs, { timeout: 20_000, signal: options.signal })));
      return selectDouyinSecUidFromRows(rows, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `opencli browser 没有解析到抖音账号「${name}」：${message || "没有返回结果"}。请确认账号名能在抖音搜索到，或临时填写主页链接 / sec_uid。`
      );
    }
  }, { signal: options.signal });
}

export async function getDouyinRelatedTopicComments(
  query: string | string[],
  options: {
    videoLimit?: number;
    maxVideoAttempts?: number;
    collectionBudget?: CommentCollectionBudget;
    commentLimit?: number;
    excludedVideoIds?: string[];
    signal?: AbortSignal;
    deadlineMs?: number;
    onTiming?: OpenCliTimingSink;
  } = {}
): Promise<DouyinRelatedCommentResult> {
  const queries = [...new Set((Array.isArray(query) ? query : [query]).map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 3);
  const cleanQuery = queries.join(" / ");
  if (!cleanQuery) {
    return { query: "", videos: [], comments: [], commentSamples: [], appliedMinLikes: 0 };
  }

  const videoLimit = Math.max(1, Math.min(options.videoLimit || DOUYIN_RELATED_COMMENT_VIDEO_LIMIT, 8));
  const commentLimit = Math.max(1, Math.min(options.commentLimit || DOUYIN_RELATED_COMMENT_PER_VIDEO_LIMIT, 200));
  const groups: Array<{ query: string; videos: DouyinRelatedCommentVideo[] }> = [];
  const searchErrors: string[] = [];
  for (const phrase of queries) {
    try {
      const stdout = await runPersistentOpenCliBrowserAdapter([
        "douyin", "search", phrase, "--limit", String(Math.min(30, Math.max(videoLimit * 4, 20))), "-f", "json"
      ], { timeout: 45_000, signal: options.signal, onTiming: options.onTiming, timingStage: "douyin.comments.search" });
      const videos = asArray(parseJsonish(stdout)).map(normalizeDouyinRelatedVideo)
        .filter((video): video is DouyinRelatedCommentVideo => Boolean(video?.id))
        .filter((video) => !isExcludedRelatedVideo(video.id, options.excludedVideoIds));
      groups.push({ query: phrase, videos });
      if (!videos.length) searchErrors.push(`抖音搜索「${phrase}」没有可采集的视频`);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const detail = formatErrorMessage(error);
      searchErrors.push(`抖音搜索「${phrase}」失败：${detail}`);
      if (/did not render result cards|验证码|verifycenter|captcha|401|403|412|429|登录/i.test(detail)) break;
    }
  }
  const rankedCandidates = selectRelatedCommentVideos(groups, groups.reduce((sum, group) => sum + group.videos.length, 0), compareDouyinRelatedVideos);
  const candidateLimit = Math.max(videoLimit, Math.min(options.maxVideoAttempts || videoLimit, 8));
  if (!rankedCandidates.length) throw new Error(searchErrors.join("；") || `抖音搜索「${cleanQuery}」没有可采集的视频`);

  return withSharedOpenCliBrowserSession(async (workspace) => {
    const eligible = await selectEligibleCommentSources(rankedCandidates, candidateLimit, {
      batchSize: DOUYIN_COMMENT_COUNT_BATCH_SIZE,
      resolveMany: (videos) => getDouyinCommentCounts(workspace, videos.map((video) => video.id), options)
    }, options.signal);
    const candidates = eligible.videos;
    searchErrors.push(...eligible.errors);
    if (!candidates.length) throw new Error(`抖音没有评论总数超过 ${SOURCE_VIDEO_COMMENT_THRESHOLD} 条的可用视频：${searchErrors.join("；")}`);
    const comments: string[] = [];
    const commentSamples: DouyinRelatedCommentSample[] = [];
    const commentErrors: string[] = [...searchErrors];
    const collectionAttempts: CommentCollectionAttempt[] = [];
    let accessError = false;
    const collected = await collectCommentSources<DouyinRelatedCommentVideo, number>({
      candidates, sourceTarget: videoLimit, signal: options.signal, budget: options.collectionBudget, deadlineMs: options.deadlineMs,
      shouldStop: () => accessError, count: (result) => result,
      read: async (video) => {
      const started = Date.now();
      const rows = await getDouyinCommentRowsWithBrowser(workspace, [video.id], commentLimit, options).catch((error) => {
        if (isAbortError(error) || options.signal?.aborted) throw error;
        const detail = formatErrorMessage(error);
        return [{ awemeId: video.id, comments: [], pages: 0, pageTrace: [], hasMore: false,
          stopReason: "failed" as const, ms: Date.now() - started, error: detail }];
      });
      const row = rows[0];
      if (row?.error || !row?.comments.length) commentErrors.push(`${video.id}：${row?.error || "没有可读取的评论"}`);
      if (row?.error && /401|403|412|429|444|登录|验证|风控/.test(row.error)) accessError = true;
      const selectedComments = dedupeDouyinCommentSamples(row?.comments || [])
        .filter((comment) => !containsPlatformUserMention(comment.text))
        .slice(0, commentLimit);
      comments.push(...selectedComments.map((comment) => comment.text));
      commentSamples.push(...selectedComments.map((comment) => ({
        ...comment,
        videoId: video.id,
        videoTitle: video.title
      })));
      collectionAttempts.push({ videoId: video.id, requestedCount: commentLimit, collectedCount: row.comments.length,
        acceptedCount: selectedComments.length, pages: row.pageTrace, stopReason: row.stopReason, elapsedMs: row.ms, error: row.error });
      options.collectionBudget?.add(selectedComments.map((comment) => comment.text));
      return selectedComments.length;
      }
    });
    const videos = collected.videos;
    const appliedMinLikes = videos.length ? Math.min(...videos.map((video) => video.likes)) : 0;

    if (!commentSamples.length && !options.collectionBudget) {
      const detail = commentErrors.length
        ? commentErrors.slice(0, 3).join("；")
        : `${videos.length} 个相关视频的评论接口均返回空结果`;
      throw new Error(`抖音搜索「${cleanQuery}」已命中 ${videos.length} 个相关视频，但没有抓到评论：${detail}`);
    }

    return {
      query: cleanQuery,
      collectionAttempts,
      videos,
      comments: uniqueStrings(comments),
      commentSamples: dedupeDouyinCommentSamples(commentSamples),
      appliedMinLikes,
      ...(commentErrors.length ? { errors: commentErrors } : {})
    };
  }, { signal: options.signal });
}

/** 与 B站评论入口一致：已知视频 ID/URL 时跳过搜索和作品详情。 */
export async function getDouyinComments(
  video: Pick<Video, "id" | "url">,
  limit = 50,
  options: OpenCliTimingOptions = {}
): Promise<DouyinCommentSample[]> {
  const awemeId = extractDouyinAwemeId(video.url) || extractDouyinAwemeId(video.id);
  if (!awemeId) throw new Error("没有识别到抖音视频 ID，请提供抖音视频链接或数字 ID");
  const commentLimit = Math.max(1, Math.min(Math.trunc(limit) || 50, 200));
  return withSharedOpenCliBrowserSession(async (workspace) => {
    const rows = await getDouyinCommentRowsWithBrowser(workspace, [awemeId], commentLimit, options);
    const row = rows[0];
    if (row.error || !row.comments.length) throw new Error(`抖音视频 ${awemeId} 评论抓取失败：${row.error || "没有可读取的评论"}`);
    return row.comments;
  }, { signal: options.signal });
}

async function getDouyinCommentRowsWithBrowser(
  workspace: string,
  awemeIds: string[],
  commentLimit: number,
  options: OpenCliTimingOptions & { tab?: string } = {}
): Promise<DouyinCommentRows[]> {
  const read = () => runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [
    buildDouyinCommentsExtractJs({ awemeIds, commentLimit })
  ], { tab: options.tab }), {
    ...options, timeout: Math.ceil(awemeIds.length / (commentLimit > 50 ? 1 : 2)) * 15_000 + 5_000, timingStage: "douyin.comments.batch"
  }).then(parseJsonish);
  let result = await read();
  if (result && typeof result === "object" && "needsSession" in result && result.needsSession) {
    // 评论接口需要作品页会话；只在尚无可用页面时初始化，后续视频按 ID 直接读取。
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [buildDouyinVideoUrl(awemeIds[0])], { window: "background", tab: options.tab }), {
      ...options, timeout: 30_000, timingStage: "douyin.comments.session-open"
    });
    result = await read();
  }
  const payload = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const rawRows = payload.rows;
  if (!Array.isArray(rawRows) || payload.needsSession || rawRows.length !== awemeIds.length) {
    throw new Error("抖音评论接口返回了无效结果，请在 Chrome 检查登录或验证状态后重试");
  }
  return awemeIds.map((awemeId) => {
    const row = rawRows.find((row: Record<string, unknown>) => row?.awemeId === awemeId);
    if (!row || !Array.isArray(row.comments)) throw new Error(`抖音视频 ${awemeId} 缺少评论结果，请重试`);
    const error = String(row.error || "").trim();
    const comments = row.comments.map(normalizeDouyinHotComment).filter((value: DouyinCommentSample | null): value is DouyinCommentSample => Boolean(value));
    const ms = toNumber(row.ms);
    options.onTiming?.({ stage: "douyin.comments.video", ms, ok: !error, meta: { awemeId, pages: toNumber(row.pages), count: comments.length }, ...(error ? { error } : {}) });
    return { awemeId, comments, pages: toNumber(row.pages), pageTrace: row.pageTrace || [],
      stopReason: row.stopReason || (error ? "failed" : Boolean(row.hasMore) ? "target_reached" : "exhausted"),
      hasMore: Boolean(row.hasMore), ms, ...(error ? { error } : {}) };
  });
}

function normalizeDouyinRelatedVideo(row: unknown): DouyinRelatedCommentVideo | null {
  const object = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const id = String(object.id || object.aweme_id || extractDouyinAwemeId(String(object.url || ""))).trim();
  if (!id) return null;
  const title = String(object.title || object.desc || object.description || "").replace(/\s+/g, " ").trim();
  return {
    id,
    title,
    // 当前搜索适配器的 comments: 0 是占位值，需查详情，不能当真实零条。
    commentCount: sourceCommentCount(object.comment_count, (object.statistics as Record<string, unknown> | undefined)?.comment_count,
      typeof object.comments === "number" && object.comments > 0 ? object.comments : undefined),
    author: typeof object.author === "string" ? object.author : String((object.author as { nickname?: string } | undefined)?.nickname || object.nickname || ""),
    likes: toNumber(object.likes || object.digg_count),
    publishedAt: normalizeTimestamp(object.publishedAt || object.createTime || object.create_time || object.date),
    url: `https://www.douyin.com/video/${encodeURIComponent(id)}`
  };
}

function compareDouyinRelatedVideos(left: DouyinRelatedCommentVideo, right: DouyinRelatedCommentVideo) {
  return relatedVideoRank(right.likes, right.publishedAt) - relatedVideoRank(left.likes, left.publishedAt);
}

function relatedVideoRank(metric: number, publishedAt?: string) {
  const timestamp = publishedAt ? Date.parse(publishedAt) : 0;
  if (!timestamp) return metric;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  const recencyWeight = ageDays <= 30 ? 1.25 : ageDays <= 180 ? 1.15 : ageDays <= 365 ? 1.05 : 0.9;
  return metric * recencyWeight;
}

function dedupeDouyinCommentSamples<T extends { text: string }>(values: T[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.text.toLowerCase();
    if (!value.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectDouyinSecUidFromRows(rows: unknown[], name: string) {
  const normalizedName = normalizeDouyinUserSearchText(name);
  const candidates = rows
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : null))
    .filter(Boolean) as Array<Record<string, unknown>>;
  const ranked = candidates
    .map((row) => ({
      row,
      matchScore: douyinUserSearchMatchScore(row, normalizedName),
      rank: douyinUserSearchRank(row)
    }))
    .filter((candidate) => candidate.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || b.rank - a.rank);
  const matched = ranked[0]?.row;

  if (!candidates.length) {
    throw new Error(`没有搜索到抖音账号：${name}`);
  }
  if (!matched) {
    throw new Error(
      `抖音搜索返回了账号候选，但没有昵称匹配「${name}」的结果${formatDouyinSearchCandidateHint(candidates)}。请粘贴该账号主页链接或 sec_uid 再采集。`
    );
  }

  const secUid = extractSecUidFromSearchRow(matched);
  if (!secUid) {
    throw new Error(`没有从搜索结果里解析到抖音 sec_uid：${name}`);
  }

  return secUid;
}

function douyinUserSearchMatchScore(row: Record<string, unknown>, normalizedName: string) {
  if (!normalizedName) return 0;
  const names = getDouyinUserSearchNames(row).map(normalizeDouyinUserSearchText).filter(Boolean);
  if (names.some((name) => name === normalizedName)) return 3;
  if (normalizedName.length >= 2 && names.some((name) => name.includes(normalizedName))) return 2;
  if (names.some((name) => name.length >= 2 && normalizedName.includes(name))) return 1;
  return 0;
}

function getDouyinUserSearchNames(row: Record<string, unknown>) {
  const userInfo = row.user_info && typeof row.user_info === "object" ? (row.user_info as Record<string, unknown>) : {};
  return [
    row.nickname,
    row.name,
    row.title,
    row.unique_id,
    row.short_id,
    userInfo.nickname,
    userInfo.name,
    userInfo.unique_id,
    userInfo.short_id
  ].map((value) => String(value || "").trim());
}

function normalizeDouyinUserSearchText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .replace(/[，。、《》“”"':：_\-·.]/g, "");
}

function douyinUserSearchRank(row: Record<string, unknown>) {
  const userInfo = row.user_info && typeof row.user_info === "object" ? (row.user_info as Record<string, unknown>) : {};
  const rankPenalty = toNumber(row.rank) ? Math.max(0, 500 - toNumber(row.rank)) : 0;
  return rankPenalty + toNumber(row.follower_count ?? userInfo.follower_count ?? row.followers);
}

function formatDouyinSearchCandidateHint(candidates: Array<Record<string, unknown>>) {
  const labels = candidates
    .flatMap(getDouyinUserSearchNames)
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name, index, list) => list.indexOf(name) === index)
    .slice(0, 5);
  return labels.length ? `（候选：${labels.join("、")}）` : "";
}

function extractSecUidFromSearchRow(row: Record<string, unknown>) {
  const userInfo = row.user_info && typeof row.user_info === "object" ? (row.user_info as Record<string, unknown>) : {};
  return String(row.sec_uid || row.sec_user_id || row.secUid || userInfo.sec_uid || userInfo.sec_user_id || extractDouyinSecUid(String(row.url || "")));
}

export async function collectVideos(input: {
  platform: Platform;
  account: Account;
  limit: number;
  order?: CollectOrder;
  page?: number;
  hydrateDetails?: boolean;
  fromDate?: string;
  toDate?: string;
  signal?: AbortSignal;
}) {
  if (input.platform === "bilibili") {
    return collectBilibiliVideos({
      account: input.account,
      limit: input.limit,
      order: input.order,
      page: input.page,
      hydrateDetails: input.hydrateDetails,
      signal: input.signal
    });
  }

  if (input.fromDate || input.toDate || input.order === "likes" || input.order === "comments" || input.order === "pubdate") {
    const [result] = await collectDouyinPostVideosBatch({ ...input, ranking: input.order === "likes" || input.order === "comments" ? input.order : undefined, accounts: [input.account], concurrency: 1 });
    if (result.status === "failed") throw new Error(result.error);
    return { command: `${opencliBin()} browser shared-post eval`, raw: result.raw, rawCount: result.rawCount, videos: result.videos };
  }
  const args = buildDouyinUserVideosArgs(input.account.uid, input.limit);
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await getDouyinVideoRows(input.account, { limit: input.limit, signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) throw createAbortError();
    const accessError = getDouyinAccessError(formatErrorMessage(error));
    if (accessError) throw new Error(accessError);
    throw error;
  }

  return {
    command: `${opencliBin()} ${args.join(" ")}`,
    rawCount: rows.length,
    raw: rows,
    videos: rows.map((row) => normalizeDouyinVideo(row, input.account))
  };
}

export async function collectDouyinPostVideosBatch(input: {
  ranking?: "likes" | "comments";
  accounts: Account[];
  concurrency: number;
  limit: number;
  fromDate?: string;
  toDate?: string;
  signal?: AbortSignal;
  onResult?: (result: DouyinBatchVideoCollectResult) => void | Promise<void>;
}): Promise<DouyinBatchVideoCollectResult[]> {
  if (!input.accounts.length) return [];

  const concurrency = Math.min(Math.max(input.concurrency, 1), input.accounts.length);

  return withSharedOpenCliBrowserSession(async (workspace) => {
    const results: DouyinBatchVideoCollectResult[] = [];
    let accessError: string | null = null;
    const emit = async (result: DouyinBatchVideoCollectResult) => {
      await input.onResult?.(result);
      results.push(result);
    };
    try {
      await ensureDouyinBatchSession(workspace, input.accounts[0].uid, input.signal);
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) throw createAbortError();
      for (const account of input.accounts) await emit(makeFailedDouyinBatchCollectResult(account, `抖音共享会话初始化失败：${formatErrorMessage(error)}`));
      return results;
    }
    for (const accounts of chunkItems(input.accounts, Math.max(6, concurrency))) {
      if (input.signal?.aborted) throw createAbortError();
      if (accessError) {
        const reason = pausedDouyinRefreshError(accessError);
        for (const account of accounts) await emit(makeFailedDouyinBatchCollectResult(account, reason));
        continue;
      }

      let chunkResults: DouyinBatchVideoCollectResult[];
      try {
        const parsed = input.ranking
          ? await collectRankedDouyinPages(workspace, accounts, input)
          : parseJsonish(await retryDetachedBrowserRead(
            () => runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [buildDouyinBatchPostExtractJs({
              accounts, concurrency, limit: Math.min(input.limit, 500), fromDate: input.fromDate, toDate: input.toDate
            })]), { timeout: 180_000, signal: input.signal }),
            () => ensureDouyinBatchSession(workspace, accounts[0].uid, input.signal),
            input.signal
          ));
        if (!Array.isArray(parsed)) throw new Error("抖音批量接口返回无效结果");
        chunkResults = accounts.map((account) => {
          const raw = parsed.find((row) => row?.accountId === account.id);
          if (raw?.status !== "completed" || !Array.isArray(raw.rows)) return makeFailedDouyinBatchCollectResult(account, raw?.error || "抖音批量接口缺少账号结果");
          const rows = raw.rows as unknown[];
          return {
            account,
            status: "completed" as const,
            raw: rows,
            rawCount: typeof raw.rawCount === "number" ? raw.rawCount : rows.length,
            videos: rows.map((row) => normalizeDouyinVideo(row, account))
          };
        });
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) throw createAbortError();
        const message = formatErrorMessage(error);
        const normalizedAccessError = getDouyinAccessError(message);
        chunkResults = accounts.map((account) => makeFailedDouyinBatchCollectResult(
          account,
          normalizedAccessError || `抖音账号「${account.name}」采集失败：${message}`
        ));
      }
      for (const result of chunkResults) await emit(result);
      accessError = chunkResults.map((result) => getDouyinAccessError(result.error || "")).find(Boolean) || null;
    }

    return results;
  }, { signal: input.signal });
}

async function collectRankedDouyinPages(
  workspace: string,
  accounts: Account[],
  input: { ranking?: "likes" | "comments"; limit: number; fromDate?: string; toDate?: string; signal?: AbortSignal }
) {
  const results = [];
  for (const account of accounts) {
    const candidates = new Map<string, Record<string, unknown>>();
    let cursor = 0;
    let rawCount = 0;
    let completed = false;
    const visited = new Set<number>();
    for (let batch = 0; batch < 100; batch++) {
      if (input.signal?.aborted) throw createAbortError();
      if (visited.has(cursor)) throw new Error("抖音历史分页游标重复，请重试采集。");
      visited.add(cursor);
      const parsed = parseJsonish(await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [buildDouyinBatchPostExtractJs({
        accounts: [account], concurrency: 1, limit: Math.min(input.limit, 500), ranking: input.ranking,
        fromDate: input.fromDate, toDate: input.toDate, pageCursor: cursor, pageBudget: 5
      })]), { timeout: 110_000, signal: input.signal }));
      const result = Array.isArray(parsed) ? parsed[0] : null;
      if (result?.status !== "completed" || !Array.isArray(result.rows)) {
        throw new Error(result?.error || "抖音历史分页返回无效结果，请重试采集。");
      }
      rawCount += Number(result.rawCount) || 0;
      for (const row of result.rows) candidates.set(String(row.aweme_id), row);
      if (result.nextCursor === null) { completed = true; break; }
      cursor = Number(result.nextCursor);
      if (!Number.isFinite(cursor) || cursor <= 0) throw new Error("抖音历史分页缺少有效游标，请重试采集。");
    }
    if (!completed) throw new Error("抖音历史作品超过 500 页采集上限，请缩小采集时间范围后重试。");
    const key = input.ranking === "likes" ? "digg_count" : "comment_count";
    const rows = [...candidates.values()].sort((a, b) => Number(b[key]) - Number(a[key]) || Number(b.create_time) - Number(a.create_time)).slice(0, input.limit);
    results.push({ accountId: account.id, status: "completed", rawCount, rows });
  }
  return results;
}

async function ensureDouyinBatchSession(workspace: string, secUid: string, signal?: AbortSignal) {
  // aweme/post 依赖抖音网页安全 SDK 为 fetch 补充动态签名。robots.txt 虽然同源，
  // 但不会加载该 SDK，会让整批请求以 ArgusSecurityPlugin Signature Not Found 失败。
  // 每轮只打开一次种子账号主页，后续所有账号仍在同一页内并发走批量接口。
  await runOpenCli(buildOpenCliBrowserArgs(
    workspace,
    "open",
    [buildDouyinBatchSessionUrl(secUid)],
    { window: "background" }
  ), {
    timeout: 30_000,
    signal
  });
}

export function buildDouyinBatchSessionUrl(secUid: string) {
  return `https://www.douyin.com/user/${encodeURIComponent(secUid)}`;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function makeFailedDouyinBatchCollectResult(account: Account, error: string): DouyinBatchVideoCollectResult {
  return {
    account,
    error,
    raw: [],
    rawCount: 0,
    status: "failed",
    videos: []
  };
}

export async function refreshDouyinVideoDownloadUrl(
  account: Account,
  video: Pick<Video, "id" | "url" | "raw">,
  options: { preferBrowser?: boolean; excludeUrls?: string[]; signal?: AbortSignal } = {}
) {
  const awemeId = resolveDouyinAwemeId(video);
  if (!awemeId) return "";
  const excludedUrls = new Set(options.excludeUrls || []);
  // An explicit browser retry can find a different stream after an audio extraction failure.
  // Normal single-work refreshes use detail directly, never scan the author's latest works.
  try {
    const mediaUrl = options.preferBrowser
      ? await getDouyinVideoDownloadUrlWithBrowser(awemeId, { signal: options.signal })
      : (await getDouyinSingleVideoReference(awemeId, { signal: options.signal })).mediaUrl;
    return mediaUrl && !excludedUrls.has(mediaUrl) ? mediaUrl : "";
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    throw new Error(`刷新抖音账号「${account.name}」的作品媒体地址失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function checkDouyinVideoAvailability(
  account: Account,
  video: Pick<Video, "id" | "url" | "raw">,
  options: { signal?: AbortSignal } = {}
) {
  const awemeId = resolveDouyinAwemeId(video);
  if (!awemeId) {
    return {
      visible: false,
      reason: "无法解析抖音视频 ID。"
    };
  }

  try {
    const rows = await getDouyinVideoRows(account, { limit: 50, signal: options.signal });
    const row = rows.find((item) => getDouyinRowAwemeId(item) === awemeId);
    if (row) {
      return {
        visible: true,
        reason: findDouyinMediaUrl(row) ? "" : "视频仍在账号列表中，但 opencli 没有返回可转写媒体地址。"
      };
    }
    return {
      visible: false,
      reason: "当前账号最近 50 条视频里找不到这条，可能已删除、隐藏、下架，或账号权限不可见。"
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      visible: null,
      reason: `无法检查视频是否仍可见：${error instanceof Error ? error.message : "opencli 检查失败"}`
    };
  }
}

export async function getDouyinVideoDownloadUrls(account: Account, options: DouyinMediaLookupOptions = {}) {
  return getDouyinVideoDownloadUrlsWithUserVideos(account, options);
}

export function getDouyinVideoDownloadLookupLimit(videos: Array<Pick<Video, "id" | "url" | "raw">>) {
  return videos.reduce((limit, video) => Math.max(limit, resolveDouyinVideoLookupLimit(video)), 20);
}

async function getDouyinVideoDownloadUrlsWithUserVideos(account: Account, options: DouyinMediaLookupOptions = {}) {
  const urls = new Map<string, string>();

  try {
    const rows = await getDouyinVideoRows(account, options);
    for (const row of rows) {
      const awemeId = getDouyinRowAwemeId(row);
      if (!awemeId) continue;
      const mediaUrl = findDouyinMediaUrl(row);
      if (mediaUrl) urls.set(awemeId, mediaUrl);
    }
    return urls;
  } catch (error) {
    const message = error instanceof Error ? error.message : "opencli 未返回结果";
    throw new Error(`刷新抖音媒体地址失败：${message}`);
  }
}

async function getDouyinVideoRows(account: Account, options: DouyinMediaLookupOptions = {}) {
  const stdout = await runPersistentOpenCliBrowserAdapter(buildDouyinUserVideosArgs(account.uid, options.limit, false), {
    timeout: 90_000,
    signal: options.signal
  });
  return openCliRows(parseJsonish(stdout))
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : null))
    .filter(Boolean) as Array<Record<string, unknown>>;
}

export function buildDouyinUserVideosArgs(secUid: string, limit?: number, withComments = false) {
  const normalizedLimit = Math.max(1, Math.min(Math.trunc(Number(limit) || DOUYIN_USER_VIDEOS_LIMIT), DOUYIN_USER_VIDEOS_LIMIT));
  return [
    "douyin",
    "user-videos",
    secUid,
    "--limit",
    String(normalizedLimit),
    "--with_comments",
    String(withComments),
    "--window",
    "background",
    "--site-session",
    "ephemeral",
    "-f",
    "json"
  ];
}

export async function getDouyinVideoDetailMap(
  account: Account,
  videos: Array<Pick<Video, "id" | "url" | "raw">>,
  options: { commentLimit?: number } = {}
) {
  const awemeIds = [...new Set(videos.map((video) => getDouyinAwemeId(video)).filter(Boolean))];
  const details = new Map<string, { commentCount?: number; topComments: string[] }>();
  if (!awemeIds.length) return details;

  const profileUrl = `https://www.douyin.com/user/${encodeURIComponent(account.uid)}`;

  return withSharedOpenCliBrowserSession(async (workspace) => {
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [profileUrl], { window: "background" }), {
      timeout: 30_000
    });
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "wait", ["time", "2"]), { timeout: 10_000 }).catch(() => undefined);

    for (const awemeId of awemeIds) {
      const detail = await getDouyinVideoDetailWithBrowser(workspace, awemeId, options).catch(() => null);
      if (!detail) continue;
      details.set(awemeId, {
        commentCount: detail.commentCount,
        topComments: detail.topComments.map((comment) => comment.text)
      });
    }
    return details;
  });
}

export function resetDouyinVideoStatsBrowser() {
  return runOpenCli(buildOpenCliBrowserArgs(sharedOpenCliBrowserSession(), "close"), { timeout: 5_000 }).catch(() => undefined);
}

export async function getDouyinVideoStatsByUrl(
  url: string,
  options: VideoStatsTimingOptions = {}
): Promise<DouyinVideoStatsResult> {
  return withDouyinStatsBrowser((workspace) => getDouyinVideoStatsByUrlInWorkspace(workspace, url, options), options);
}

export async function resolveDouyinVideoUrl(
  url: string,
  options: VideoStatsTimingOptions = {}
) {
  const inputUrl = url.trim();
  const resolvedShareUrl = await resolveDouyinShareVideoUrl(inputUrl, options);
  if (/v\.douyin\.com/i.test(inputUrl) && !resolvedShareUrl) {
    throw new Error("抖音短链无法解析，请确认链接仍有效，或粘贴完整视频链接。");
  }
  const awemeId = extractDouyinAwemeId(inputUrl) || extractDouyinAwemeId(resolvedShareUrl);
  if (!awemeId) {
    throw new Error("没有从链接里解析到抖音视频 ID，请粘贴单条视频链接。");
  }
  return buildDouyinVideoUrl(awemeId) || resolvedShareUrl || inputUrl;
}

export async function getDouyinVideoAuthorNameByUrl(
  url: string,
  options: VideoStatsTimingOptions = {}
) {
  return withDouyinStatsBrowser(async (workspace) => {
    const resolvedUrl = await resolveDouyinVideoUrl(url, options);
    const awemeId = extractDouyinAwemeId(resolvedUrl);
    if (!awemeId) return "";
    const detail = await getDouyinVideoDetailSnapshot(workspace, awemeId, options);
    return detail?.authorName?.trim() || "";
  }, options);
}

export async function getDouyinVideoStatsBatchByUrl(
  urls: string[],
  options: VideoStatsTimingOptions = {}
): Promise<Array<DouyinVideoStatsResult | null>> {
  const normalizedUrls = urls.map((url) => url.trim());
  if (!normalizedUrls.length) return [];

  return withDouyinStatsBrowser(async (workspace) => {
    const directItems = await timeOpenCliOperation(
      options,
      "douyin.batch.resolve-share-url",
      () => Promise.all(
        normalizedUrls.map(async (url, index) => {
          const resolvedShareUrl = await resolveDouyinShareVideoUrl(url, options).catch(ignoreAbortToEmptyString);
          const awemeId = extractDouyinAwemeId(url) || extractDouyinAwemeId(resolvedShareUrl);
          return {
            index,
            url,
            resolvedUrl: resolvedShareUrl,
            awemeId
          };
        })
      ),
      { count: normalizedUrls.length }
    );
    const resultByIndex = new Map<number, DouyinVideoStatsResult | null>();
    const directAwemeIds = [...new Set(directItems.map((item) => item.awemeId).filter(Boolean))];
    const detailByAwemeId = await getDouyinVideoDetailSnapshots(workspace, directAwemeIds, options).catch(() => new Map<string, DouyinVideoStatsSnapshot>());

    for (const item of directItems) {
      const detail = item.awemeId ? detailByAwemeId.get(item.awemeId) : null;
      if (!item.awemeId || !detail) continue;
      resultByIndex.set(
        item.index,
        formatDouyinVideoStatsResult(detail, buildDouyinVideoUrl(item.awemeId) || item.resolvedUrl || item.url)
      );
    }

    await mapWithLocalConcurrency(
      directItems.filter((item) => !resultByIndex.has(item.index)),
      2,
      async (item) => {
        const result = await getDouyinVideoStatsByUrlInWorkspace(
          workspace,
          item.url,
          withTimingMeta(options, { index: item.index, fallback: true })
        ).catch(() => null);
        resultByIndex.set(item.index, result);
      }
    );

    return normalizedUrls.map((_, index) => resultByIndex.get(index) || null);
  }, options);
}

export async function hydrateDouyinVideoStatsBatch(
  videos: Video[],
  options: VideoStatsTimingOptions = {}
): Promise<Video[]> {
  if (!videos.length) return [];

  return withDouyinStatsBrowser(async (workspace) => {
    const awemeIds = videos.map((video) => extractDouyinAwemeId(video.id) || extractDouyinAwemeId(video.url));
    const errors = new Map<string, string>();
    const details = await getDouyinVideoDetailSnapshots(workspace, awemeIds.filter(Boolean), options, errors);
    const checkedAt = nowIso();

    return videos.map((video, index) => {
      const awemeId = awemeIds[index];
      const detail = awemeId ? details.get(awemeId) : null;
      if (!detail) {
        return {
          ...video,
          statsHydration: {
            status: "failed",
            source: "opencli",
            checkedAt,
            missingFields: missingDouyinDetailFields(video),
            error: awemeId
              ? errors.get(awemeId) || "抖音详情接口没有返回统计数据。"
              : "没有从视频记录中解析到抖音视频 ID。"
          }
        };
      }

      const missingFields = detail.missingFields || [];
      const detailStats = {
        likes: detail.likeCount,
        comments: detail.commentCount,
        favorites: detail.favoriteCount,
        shares: detail.shareCount
      };
      const statistics = Object.fromEntries(
        ([ ["digg_count", "likes", detail.likeCount], ["comment_count", "comments", detail.commentCount], ["collect_count", "favorites", detail.favoriteCount], ["share_count", "shares", detail.shareCount] ] as const)
          .filter(([, field]) => !missingFields.includes(field))
          .map(([key, , value]) => [key, value])
      );
      return {
        ...video,
        title: detail.title || video.title,
        publishedAt: detail.publishedAt || video.publishedAt,
        stats: {
          ...video.stats,
          ...Object.fromEntries(Object.entries(detailStats).filter(([field]) => !missingFields.includes(field as DouyinDetailStatField)))
        },
        statsHydration: {
          status: missingFields.length ? "partial" : "complete",
          source: "opencli",
          checkedAt,
          missingFields,
          ...(missingFields.length ? { error: "抖音详情接口返回的统计字段不完整，请检查网页会话后重试。" } : {})
        },
        raw: {
          ...(video.raw && typeof video.raw === "object" ? video.raw : {}),
          detail: {
            create_time: detail.publishedAt,
            statistics
          }
        },
        updatedAt: checkedAt
      };
    });
  }, options);
}

export async function hydrateDouyinVideoStats(
  video: Video,
  options: VideoStatsTimingOptions = {}
): Promise<Video> {
  const [hydrated] = await hydrateDouyinVideoStatsBatch([video], options);
  if (hydrated.statsHydration?.status !== "complete") {
    throw new Error(hydrated.statsHydration?.error || "抖音详情接口没有返回统计数据。");
  }
  return hydrated;
}

async function withDouyinStatsBrowser<T>(
  callback: (workspace: string) => Promise<T>,
  options: VideoStatsTimingOptions = {}
): Promise<T> {
  return withSharedOpenCliBrowserSession(async (workspace) => {
    await ensureDouyinStatsBrowser(workspace, options);
    return callback(workspace);
  }, { signal: options.signal });
}

async function ensureDouyinStatsBrowser(workspace: string, options: VideoStatsTimingOptions = {}) {
  await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [DOUYIN_STATS_HOME_URL], { window: "background" }), {
    timeout: 30_000,
    timingStage: "douyin.browser.ensure-open",
    onTiming: options.onTiming,
    timingMeta: options.timingMeta,
    signal: options.signal
  });
}

async function getDouyinVideoStatsByUrlInWorkspace(
  workspace: string,
  url: string,
  options: VideoStatsTimingOptions = {}
): Promise<DouyinVideoStatsResult> {
  const inputUrl = url.trim();
  const resolvedShareUrl = await timeOpenCliOperation(
    options,
    "douyin.resolve-share-url",
    () => resolveDouyinShareVideoUrl(inputUrl, options).catch(ignoreAbortToEmptyString),
    { shortLink: /v\.douyin\.com/i.test(inputUrl) }
  );
  const initialAwemeId = extractDouyinAwemeId(inputUrl) || extractDouyinAwemeId(resolvedShareUrl);
  const pageUrl = initialAwemeId ? buildDouyinVideoUrl(initialAwemeId) || resolvedShareUrl || inputUrl : resolvedShareUrl || inputUrl;

  if (initialAwemeId) {
    const fastDetail = await getDouyinVideoDetailSnapshot(workspace, initialAwemeId, options).catch(ignoreAbortToNull);
    if (fastDetail) {
      return formatDouyinVideoStatsResult(fastDetail, buildDouyinVideoUrl(initialAwemeId) || pageUrl);
    }
  }

  await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [pageUrl], { window: "background" }), {
    timeout: 30_000,
    timingStage: "douyin.browser.open-video",
    onTiming: options.onTiming,
    timingMeta: options.timingMeta,
    signal: options.signal
  });
  const resolved = await resolveDouyinAwemeIdFromOpenPage(workspace, initialAwemeId, options);
  const awemeId = resolved.awemeId;
  if (!awemeId) {
    throw new Error("没有从链接里解析到抖音视频 ID，请确认是单条视频链接，或粘贴完整视频页链接。");
  }
  const detail = await waitForDouyinVideoStats(workspace, awemeId, options);

  if (!detail) {
    throw new Error("抖音页面已打开，但没有从真实浏览器网络里抓到点赞、评论、收藏或转发数据。");
  }

  const resolvedUrl = resolved.url || buildDouyinVideoUrl(awemeId) || pageUrl;
  return formatDouyinVideoStatsResult(detail, resolvedUrl);
}

export async function getDouyinVideoStatsFromAccount(input: {
  account: Account;
  url: string;
  limit?: number;
  videos?: Video[];
}) {
  const awemeId = extractDouyinAwemeId(input.url);
  if (!awemeId) {
    throw new Error("没有从链接里解析到抖音视频 ID，请粘贴完整视频链接。");
  }

  const videos =
    input.videos ||
    (
      await collectVideos({
        platform: "douyin",
        account: input.account,
        limit: input.limit || 500
      })
    ).videos;
  const matched = videos.find((video) => getDouyinAwemeId(video) === awemeId);
  if (!matched) {
    throw new Error(`账号「${input.account.name}」最近 ${videos.length} 条视频里没有找到这条视频。`);
  }

  return {
    platform: "douyin" as const,
    title: matched.title,
    url: matched.url || buildDouyinVideoUrl(awemeId) || input.url,
    publishedAt: matched.publishedAt,
    stats: {
      like: matched.stats.likes,
      comment: matched.stats.comments,
      favorite: matched.stats.favorites,
      share: matched.stats.shares || 0
    }
  };
}

async function getDouyinVideoDetailFromNetwork(
  workspace: string,
  awemeId: string,
  options: VideoStatsTimingOptions = {}
): Promise<DouyinVideoStatsSnapshot | null> {
  const previews = await getDouyinNetworkPreviews(workspace, options);
  const candidates = getOpenCliNetworkEntries(previews)
    .filter((entry) => isLikelyDouyinAwemeDetailEntry(entry, awemeId))
    .sort(compareDouyinNetworkEntries);

  for (const entry of candidates) {
    const key = stringField(entry.key);
    if (!key) continue;

    const detail = parseJsonish(
      await runOpenCli(buildOpenCliBrowserArgs(workspace, "network", ["--detail", key, "--max-body", "0"]), {
        timeout: 20_000,
        timingStage: "douyin.browser.network.detail",
        onTiming: options.onTiming,
        timingMeta: mergeTimingMeta(options.timingMeta, { awemeId }),
        signal: options.signal
      })
    );
    const snapshot = extractDouyinStatsSnapshotFromNetworkDetail(detail, awemeId);
    if (snapshot) return snapshot;
  }

  return null;
}

async function resolveDouyinShareVideoUrl(url: string, options: VideoStatsTimingOptions = {}) {
  if (!/v\.douyin\.com/i.test(url)) return "";
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw createAbortError();
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 style-library",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const resolvedUrl = response.url || "";
    return extractDouyinAwemeId(resolvedUrl) ? resolvedUrl : "";
  } catch (error) {
    if (options.signal?.aborted) throw createAbortError();
    if (isAbortError(error)) throw error;
    return "";
  } finally {
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }
}

async function waitForDouyinVideoStats(
  workspace: string,
  awemeId: string,
  options: VideoStatsTimingOptions = {}
) {
  const deadline = Date.now() + 8_000;
  let lastDetail: DouyinVideoStatsSnapshot | null = null;

  while (Date.now() < deadline) {
    lastDetail =
      (await getDouyinVideoDetailSnapshot(workspace, awemeId, options).catch(ignoreAbortToNull)) ||
      (await getDouyinVideoDetailFromNetwork(workspace, awemeId, options).catch(ignoreAbortToNull));
    if (lastDetail) return lastDetail;
    await wait(700, options.signal);
  }

  return (
    lastDetail ||
    (await getDouyinVideoDetailFromNetwork(workspace, awemeId, options).catch(ignoreAbortToNull)) ||
    (await getDouyinVideoDetailSnapshot(workspace, awemeId, options).catch(ignoreAbortToNull))
  );
}

function formatDouyinVideoStatsResult(detail: DouyinVideoStatsSnapshot, url: string): DouyinVideoStatsResult {
  return {
    platform: "douyin",
    title: detail.title,
    url,
    videoKey: getVideoComparableKey(url),
    publishedAt: detail.publishedAt,
    authorName: detail.authorName,
    authorSecUid: detail.authorSecUid,
    stats: {
      like: detail.likeCount,
      comment: detail.commentCount,
      favorite: detail.favoriteCount,
      share: detail.shareCount
    }
  };
}

function wait(durationMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function mapWithLocalConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await mapper(items[index], index);
      }
    })
  );
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /aborted|任务已停止/i.test(error.message));
}

function createAbortError() {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message.replace(/\s+/g, " ").trim().slice(0, 240);
  if (typeof error === "string" && error.trim()) return error.replace(/\s+/g, " ").trim().slice(0, 240);
  return "未知错误";
}

function ignoreAbortToNull(error: unknown) {
  if (isAbortError(error)) throw error;
  return null;
}

function ignoreAbortToEmptyString(error: unknown) {
  if (isAbortError(error)) throw error;
  return "";
}

async function getDouyinNetworkPreviews(workspace: string, options: VideoStatsTimingOptions = {}) {
  const filtered = await runOpenCli(
    buildOpenCliBrowserArgs(workspace, "network", ["--since", "60s", "--filter", "aweme_detail,statistics"]),
    {
      timeout: 12_000,
      timingStage: "douyin.browser.network.preview-filtered",
      onTiming: options.onTiming,
      timingMeta: options.timingMeta,
      signal: options.signal
    }
  ).catch(ignoreAbortToEmptyString);
  const parsedFiltered = parseJsonish(filtered);
  if (getOpenCliNetworkEntries(parsedFiltered).length) return parsedFiltered;

  const all = await runOpenCli(buildOpenCliBrowserArgs(workspace, "network", ["--since", "60s"]), {
    timeout: 12_000,
    timingStage: "douyin.browser.network.preview-all",
    onTiming: options.onTiming,
    timingMeta: options.timingMeta,
    signal: options.signal
  }).catch(ignoreAbortToEmptyString);
  return parseJsonish(all);
}

function getOpenCliNetworkEntries(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  }
  if (!raw || typeof raw !== "object") return [];

  const object = raw as Record<string, unknown>;
  for (const key of ["entries", "items", "results", "requests", "list", "data"]) {
    const value = object[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
    }
  }
  return [];
}

function isLikelyDouyinAwemeDetailEntry(entry: Record<string, unknown>, awemeId: string) {
  const url = stringField(entry.url);
  const shape = JSON.stringify(entry.shape || entry.body_shape || entry.preview || "");
  if (url.includes("/aweme/v1/web/aweme/detail/")) return !awemeId || url.includes(awemeId) || url.includes("aweme_id=");
  return /aweme_detail|statistics|digg_count|comment_count|collect_count|share_count/i.test(shape);
}

function compareDouyinNetworkEntries(left: Record<string, unknown>, right: Record<string, unknown>) {
  return getDouyinNetworkEntryScore(right) - getDouyinNetworkEntryScore(left);
}

function getDouyinNetworkEntryScore(entry: Record<string, unknown>) {
  const url = stringField(entry.url);
  const shape = JSON.stringify(entry.shape || entry.body_shape || entry.preview || "");
  let score = 0;
  if (url.includes("/aweme/v1/web/aweme/detail/")) score += 50;
  if (shape.includes("aweme_detail")) score += 30;
  if (shape.includes("statistics")) score += 20;
  return score;
}

function extractDouyinStatsSnapshotFromNetworkDetail(detail: unknown, awemeId: string): DouyinVideoStatsSnapshot | null {
  const payload = parseOpenCliNetworkBody(detail);
  const awemeDetail = findDouyinAwemeDetail(payload, awemeId);
  if (!awemeDetail) return null;

  const statistics = awemeDetail.statistics && typeof awemeDetail.statistics === "object"
    ? (awemeDetail.statistics as Record<string, unknown>)
    : null;
  if (!statistics) return null;

  return {
    title: stringField(awemeDetail.desc) || stringField(awemeDetail.title),
    likeCount: toNumber(statistics.digg_count),
    commentCount: toNumber(statistics.comment_count),
    favoriteCount: toNumber(statistics.collect_count),
    shareCount: toNumber(statistics.share_count),
    publishedAt: normalizeTimestamp(awemeDetail.create_time || awemeDetail.createTime),
    authorName: extractDouyinAuthorName(awemeDetail),
    authorSecUid: extractDouyinAuthorSecUid(awemeDetail)
  };
}

function extractDouyinAuthorName(awemeDetail: Record<string, unknown>) {
  const author = awemeDetail.author && typeof awemeDetail.author === "object" ? (awemeDetail.author as Record<string, unknown>) : {};
  return stringField(author.nickname) || stringField(author.name) || stringField(author.unique_id);
}

function extractDouyinAuthorSecUid(awemeDetail: Record<string, unknown>) {
  const author = awemeDetail.author && typeof awemeDetail.author === "object" ? (awemeDetail.author as Record<string, unknown>) : {};
  return stringField(author.sec_uid) || stringField(author.secUid) || stringField(author.sec_user_id);
}

function parseOpenCliNetworkBody(detail: unknown): unknown {
  const object = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null;
  const body = object && "body" in object ? object.body : detail;
  if (typeof body !== "string") return body;

  try {
    return JSON.parse(body);
  } catch {
    const jsonMatch = body.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return body;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return body;
    }
  }
}

function findDouyinAwemeDetail(value: unknown, awemeId: string, depth = 0): Record<string, unknown> | null {
  if (!value || depth > 8) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDouyinAwemeDetail(item, awemeId, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  const object = value as Record<string, unknown>;
  const direct = object.aweme_detail || object.awemeDetail;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const found = findDouyinAwemeDetail(direct, awemeId, depth + 1);
    if (found) return found;
  }

  if (object.statistics && typeof object.statistics === "object" && matchesDouyinAwemeId(object, awemeId)) {
    return object;
  }

  for (const nested of Object.values(object)) {
    const found = findDouyinAwemeDetail(nested, awemeId, depth + 1);
    if (found) return found;
  }

  return null;
}

function matchesDouyinAwemeId(object: Record<string, unknown>, awemeId: string) {
  if (!awemeId) return true;
  const candidates = [
    object.aweme_id,
    object.awemeId,
    object.id,
    object.item_id,
    object.itemId,
    object.group_id,
    object.groupId
  ];
  return candidates.some((candidate) => String(candidate || "") === awemeId);
}

async function resolveDouyinAwemeIdFromOpenPage(
  workspace: string,
  fallbackAwemeId = "",
  options: VideoStatsTimingOptions = {}
) {
  if (fallbackAwemeId) {
    return {
      awemeId: fallbackAwemeId,
      url: buildDouyinVideoUrl(fallbackAwemeId)
    };
  }

  const result = parseJsonish(
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [DOUYIN_AWEME_ID_EXTRACT_JS]), {
      timeout: 20_000,
      timingStage: "douyin.browser.eval.resolve-id",
      onTiming: options.onTiming,
      timingMeta: options.timingMeta,
      signal: options.signal
    })
  );
  const object = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  const awemeId = extractDouyinAwemeId(stringField(object.awemeId)) || extractDouyinAwemeId(stringField(object.url));
  return {
    awemeId,
    url: stringField(object.url)
  };
}

async function getDouyinVideoDetailWithBrowser(
  workspace: string,
  awemeId: string,
  options: { commentLimit?: number; signal?: AbortSignal; tab?: string } = {}
) {
  const commentLimit = Math.max(1, Math.min(options.commentLimit || 10, 200));
  const result = parseJsonish(
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [
      buildDouyinDetailExtractJs({
        awemeId,
        commentLimit
      })
    ], options.tab ? { tab: options.tab } : {}), { timeout: 20_000, signal: options.signal })
  );
  const object = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  const commentFetch = object.commentFetch && typeof object.commentFetch === "object"
    ? object.commentFetch as Record<string, unknown>
    : {};
  const topComments = Array.isArray(object.topComments)
    ? object.topComments.map(normalizeDouyinHotComment).filter((comment): comment is { text: string; likes: number; replies: number } => Boolean(comment?.text))
    : [];
  const commentCount = toNumber(object.commentCount);
  const commentFetchError = String(commentFetch.error || "").trim();
  if (!topComments.length) {
    if (commentFetchError) {
      throw new Error(`抖音视频 ${awemeId} 评论抓取失败：${commentFetchError}`);
    }
    throw new Error(
      commentCount > 0
        ? `抖音视频 ${awemeId} 显示有 ${commentCount} 条评论，但评论接口返回 0 条`
        : `抖音视频 ${awemeId} 没有可读取的评论`
    );
  }
  return {
    title: String(object.title || "").replace(/\s+/g, " ").trim(),
    commentCount: commentCount > 0 ? commentCount : undefined,
    topComments,
    likeCount: toNumber(object.likeCount),
    publishedAt: normalizeTimestamp(object.publishedAt || object.createTime || object.create_time)
  };
}

function normalizeDouyinHotComment(value: unknown) {
  if (typeof value === "string") return { text: normalizeCommentText(value), likes: 0, replies: 0 };
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = normalizeCommentText(object.text || object.content);
  if (!text) return null;
  return {
    text,
    likes: toNumber(object.likes || object.digg_count),
    replies: toNumber(object.replies || object.reply_comment_total)
  };
}

async function getDouyinVideoDetailSnapshot(
  workspace: string,
  awemeId: string,
  options: VideoStatsTimingOptions = {}
): Promise<DouyinVideoStatsSnapshot | null> {
  const read = async () => parseJsonish(
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [buildDouyinStatsExtractJs(awemeId)]), {
      timeout: 20_000,
      timingStage: "douyin.browser.eval.stats",
      onTiming: options.onTiming,
      timingMeta: mergeTimingMeta(options.timingMeta, { awemeId }),
      signal: options.signal
    })
  );
  let result = await read();
  if (result && typeof result === "object" && "needsSession" in result && result.needsSession) {
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [buildDouyinVideoUrl(awemeId)], { window: "background" }), {
      timeout: 30_000, signal: options.signal, onTiming: options.onTiming, timingStage: "douyin.stats.session-open"
    });
    result = await read();
  }
  const object = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  if (object.needsSession) throw new Error("抖音详情核验未能建立抖音页面会话，请在 Chrome 检查页面或网络后重试。");
  if (!object.hasStats) return null;
  return {
    title: stringField(object.title),
    missingFields: douyinSnapshotMissingFields(object),
    likeCount: toNumber(object.likeCount),
    commentCount: toNumber(object.commentCount),
    favoriteCount: toNumber(object.favoriteCount),
    shareCount: toNumber(object.shareCount),
    publishedAt: normalizeTimestamp(object.publishedAt || object.createTime || object.create_time),
    authorName: stringField(object.authorName),
    authorSecUid: stringField(object.authorSecUid)
  };
}

/** 按评论来源门槛批量读取评论总数：一次 eval 核验一组作品，缺少统计返回 undefined。 */
async function getDouyinCommentCounts(workspace: string, awemeIds: string[], options: VideoStatsTimingOptions = {}) {
  const ids = [...new Set(awemeIds.filter(Boolean))];
  const counts = new Map<string, number | undefined | Error>();
  if (!ids.length) return counts;
  const read = async () => parseJsonish(await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [buildDouyinCommentCountsJs(ids)]), {
    timeout: Math.max(20_000, Math.ceil(ids.length / 3) * 15_000),
    timingStage: "douyin.browser.eval.comment-counts",
    onTiming: options.onTiming,
    timingMeta: mergeTimingMeta(options.timingMeta, { count: ids.length }),
    signal: options.signal
  }));
  let result = await read();
  if (result && typeof result === "object" && "needsSession" in result && result.needsSession) {
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [buildDouyinVideoUrl(ids[0])], { window: "background" }), {
      timeout: 30_000, signal: options.signal, onTiming: options.onTiming, timingStage: "douyin.stats.session-open"
    });
    result = await read();
  }
  const object = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  if (object.needsSession) throw new Error("抖音详情核验未能建立抖音页面会话，请在 Chrome 检查页面或网络后重试。");
  for (const row of Array.isArray(object.rows) ? object.rows : []) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const awemeId = stringField(value.awemeId);
    if (!awemeId) continue;
    if (value.error) counts.set(awemeId, new Error(stringField(value.error)));
    else counts.set(awemeId, value.hasStats ? toNumber(value.commentCount) : undefined);
  }
  for (const awemeId of ids) if (!counts.has(awemeId)) counts.set(awemeId, new Error("抖音详情核验没有返回该作品的结果。"));
  return counts;
}

async function getDouyinVideoDetailSnapshots(
  workspace: string,
  awemeIds: string[],
  options: VideoStatsTimingOptions = {},
  errors = new Map<string, string>()
) {
  const uniqueAwemeIds = [...new Set(awemeIds.filter(Boolean))];
  const details = new Map<string, DouyinVideoStatsSnapshot>();
  if (!uniqueAwemeIds.length) return details;

  const result = parseJsonish(
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [buildDouyinBatchStatsExtractJs(uniqueAwemeIds)]), {
      timeout: Math.max(20_000, uniqueAwemeIds.length * 2_500),
      timingStage: "douyin.browser.eval.batch-stats",
      onTiming: options.onTiming,
      timingMeta: mergeTimingMeta(options.timingMeta, { count: uniqueAwemeIds.length }),
      signal: options.signal
    })
  );
  const rows = openCliRows(result);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const object = row as Record<string, unknown>;
    const awemeId = extractDouyinAwemeId(stringField(object.awemeId));
    if (!awemeId) continue;
    if (!object.hasStats) {
      errors.set(awemeId, stringField(object.error) || "抖音详情接口没有返回统计数据。");
      continue;
    }
    details.set(awemeId, {
      title: stringField(object.title),
      missingFields: douyinSnapshotMissingFields(object),
      likeCount: toNumber(object.likeCount),
      commentCount: toNumber(object.commentCount),
      favoriteCount: toNumber(object.favoriteCount),
      shareCount: toNumber(object.shareCount),
      publishedAt: normalizeTimestamp(object.publishedAt || object.createTime || object.create_time),
      authorName: stringField(object.authorName),
      authorSecUid: stringField(object.authorSecUid)
    });
  }
  return details;
}

export async function getDouyinTopComments(account: Account, options: { limit?: number; commentLimit?: number } = {}) {
  const args = buildDouyinUserVideosArgs(account.uid, options.limit, true);
  args.splice(args.indexOf("-f"), 0,
    "--comment_limit",
    String(Math.max(1, Math.min(options.commentLimit || 10, 30)))
  );
  const stdout = await runPersistentOpenCliBrowserAdapter(args);
  return asArray(parseJsonish(stdout))
    .flatMap((row) => {
      const object = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      const topComments = Array.isArray(object.top_comments) ? object.top_comments : [];
      return topComments.map((comment) => normalizeCommentText(comment)).filter(Boolean);
    })
    .filter(Boolean);
}

function resolveDouyinVideoLookupLimit(video: Pick<Video, "id" | "url" | "raw">) {
  const raw = video.raw && typeof video.raw === "object" ? (video.raw as Record<string, unknown>) : {};
  const index = toNumber(raw.index);
  return Math.min(Math.max(index || 20, 20), 50);
}

async function getDouyinVideoDownloadUrlWithBrowser(awemeId: string, options: { signal?: AbortSignal } = {}) {
  const videoUrl = buildDouyinVideoUrl(awemeId);
  if (!videoUrl) return "";

  return withSharedOpenCliBrowserSession(async (workspace) => {
    const openResult = parseJsonish(
      await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [videoUrl], { window: "background" }), {
        timeout: 30_000,
        signal: options.signal
      })
    );
    const tab = openResult && typeof openResult === "object" ? String((openResult as Record<string, unknown>).page || "") : "";
    const evalArgs = buildOpenCliBrowserArgs(workspace, "eval", [DOUYIN_MEDIA_EXTRACT_JS], tab ? { tab } : {});
    const candidates = asArray(parseJsonish(await runOpenCli(evalArgs, { timeout: 20_000, signal: options.signal })))
      .map((value) => String(value || "").trim())
      .filter(isLikelyDirectMediaUrl);
    return selectBestDouyinMediaUrl(candidates);
  }, { signal: options.signal });
}

export function getDouyinAwemeId(video: Pick<Video, "id" | "url" | "raw">) {
  return resolveDouyinAwemeId(video);
}

function resolveDouyinAwemeId(video: Pick<Video, "id" | "url" | "raw">) {
  const raw = video.raw && typeof video.raw === "object" ? (video.raw as Record<string, unknown>) : {};
  return (
    extractDouyinAwemeId(video.id) ||
    extractDouyinAwemeId(video.url) ||
    getDouyinRowAwemeId(raw)
  );
}

function getDouyinRowAwemeId(row: Record<string, unknown>) {
  const explicit = extractDouyinAwemeId(
    String(row.aweme_id || row.awemeId || row.awemeID || row.video_id || row.videoId || "")
  );
  if (explicit) return explicit;

  for (const key of ["share_url", "shareUrl", "web_url", "link", "page_url", "pageUrl", "uri"]) {
    const awemeId = extractDouyinAwemeId(String(row[key] || ""));
    if (awemeId) return awemeId;
  }

  return "";
}

function findDouyinMediaUrl(row: Record<string, unknown>) {
  const candidates = [
    row.play_url,
    row.download_url,
    row.video_url,
    row.media_url,
    row.video_play_url,
    row.url
  ]
    .map((value) => String(value || "").trim())
    .filter(isLikelyDirectMediaUrl);

  const video = row.video && typeof row.video === "object" ? (row.video as Record<string, unknown>) : {};
  const playAddr = video.play_addr && typeof video.play_addr === "object" ? (video.play_addr as Record<string, unknown>) : {};
  const downloadAddr =
    video.download_addr && typeof video.download_addr === "object" ? (video.download_addr as Record<string, unknown>) : {};

  for (const source of [playAddr, downloadAddr]) {
    const urlList = source.url_list;
    if (!Array.isArray(urlList)) continue;
    candidates.push(...urlList.map((value) => String(value || "").trim()).filter(isLikelyDirectMediaUrl));
  }

  return selectBestDouyinMediaUrl(candidates);
}

function selectBestDouyinMediaUrl(urls: string[]) {
  const unique = [...new Set(urls.filter(Boolean))];
  return unique.sort((a, b) => douyinMediaUrlScore(b) - douyinMediaUrlScore(a))[0] || "";
}

function douyinMediaUrlScore(url: string) {
  let score = 0;
  try {
    const parsed = new URL(url);
    const text = `${parsed.pathname} ${parsed.search}`.toLowerCase();
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();

    if (mimeType.startsWith("audio_")) score += 1000;
    if (mimeType === "video_mp4") score -= 300;
    if (/\.(m4a|mp3|aac|wav|flac|ogg)(\?|$)/i.test(parsed.pathname)) score += 900;
    if (/playwm|play_addr|download_addr|music|audio/.test(text)) score += 120;
    if (/mime_type=video_mp4|\/video\/tos\//.test(text)) score -= 120;

    const bitrate = Number(parsed.searchParams.get("br") || parsed.searchParams.get("bt") || 0);
    if (Number.isFinite(bitrate)) score += Math.min(bitrate, 2000) / 100;
  } catch {
    if (/\.(m4a|mp3|aac|wav|flac|ogg)(\?|$)/i.test(url)) score += 900;
  }

  return score;
}

function normalizeDouyinVideo(row: unknown, account: Account): Video {
  const object = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const title = String(object.title || object.desc || object.caption || "未命名视频");
  const awemeId = getDouyinRowAwemeId(object);
  const publishedAt =
    normalizeTimestamp(
      object.publishedAt || object.published_at || object.publish_time || object.date || object.create_time || object.created_at
    );
  const sourceUrls = [
    object.play_url,
    object.download_url,
    object.video_url,
    object.share_url,
    object.shareUrl,
    object.web_url,
    object.link,
    object.url
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const downloadUrl = sourceUrls.find(isLikelyDirectMediaUrl) || "";
  const pageUrl =
    buildDouyinVideoUrl(awemeId) ||
    sourceUrls.find((url) => /^https?:\/\//i.test(url) && !isLikelyDirectMediaUrl(url)) ||
    downloadUrl;
  const rawStatistics =
    object.raw_statistics && typeof object.raw_statistics === "object" ? (object.raw_statistics as Record<string, unknown>) : {};
  const statistics =
    object.statistics && typeof object.statistics === "object" ? (object.statistics as Record<string, unknown>) : {};
  const nestedStats = object.stats && typeof object.stats === "object" ? (object.stats as Record<string, unknown>) : {};
  const topComments = Array.isArray(object.top_comments)
    ? object.top_comments.map((comment) => normalizeCommentText(comment)).filter(Boolean)
    : [];
  const missingFields = missingDouyinDetailFieldsFromObject(object);

  return {
    id: safeSegment(awemeId || shortHash(`${title}-${downloadUrl}`)),
    platform: "douyin",
    accountId: account.id,
    title,
    url: pageUrl,
    duration: String(object.duration || ""),
    publishedAt,
    stats: {
      views: firstNumber(
        object.play_count,
        object.view_count,
        object.video_play_count,
        object.total_play_count,
        object.play,
        object.views,
        object.view,
        rawStatistics.play_count,
        rawStatistics.view_count,
        rawStatistics.video_play_count,
        rawStatistics.total_play_count,
        statistics.play_count,
        statistics.view_count,
        statistics.video_play_count,
        statistics.total_play_count,
        nestedStats.play_count,
        nestedStats.view_count,
        nestedStats.video_play_count,
        nestedStats.total_play_count,
        nestedStats.views
      ),
      likes: firstNumber(object.digg_count, rawStatistics.digg_count, statistics.digg_count, nestedStats.digg_count, object.likes, object.like),
      comments: firstNumber(object.comment_count, rawStatistics.comment_count, statistics.comment_count, nestedStats.comment_count, object.comments),
      favorites: firstNumber(object.collect_count, rawStatistics.collect_count, statistics.collect_count, nestedStats.collect_count, object.favorites, object.collect),
      shares: firstNumber(object.share_count, rawStatistics.share_count, statistics.share_count, nestedStats.share_count, object.shares)
    },
    hotScore: 0,
    relativeViewRate: 0,
    transcriptStatus: "not_started",
    statsHydration: {
      status: missingFields.length ? "partial" : "complete",
      source: "collect",
      checkedAt: nowIso(),
      missingFields
    },
    downloadUrl,
    topComments,
    raw: row,
    updatedAt: nowIso()
  };
}

function missingDouyinDetailFields(video: Video): Array<keyof Video["stats"]> {
  const recordedMissing = video.statsHydration?.missingFields;
  if (recordedMissing?.length) return recordedMissing;
  if (video.statsHydration?.status === "complete") return [];
  return DOUYIN_DETAIL_STAT_FIELDS.filter((field) => field !== "likes" || video.stats.likes <= 0);
}

function missingDouyinDetailFieldsFromObject(object: Record<string, unknown>): DouyinDetailStatField[] {
  const rawStatistics = object.raw_statistics && typeof object.raw_statistics === "object"
    ? object.raw_statistics as Record<string, unknown>
    : {};
  const statistics = object.statistics && typeof object.statistics === "object"
    ? object.statistics as Record<string, unknown>
    : {};
  const nestedStats = object.stats && typeof object.stats === "object"
    ? object.stats as Record<string, unknown>
    : {};
  const sources = [object, rawStatistics, statistics, nestedStats];
  const aliases: Record<DouyinDetailStatField, string[]> = {
    likes: ["digg_count", "likes", "like"],
    comments: ["comment_count", "comments"],
    favorites: ["collect_count", "favorites", "collect"],
    shares: ["share_count", "shares"]
  };

  return DOUYIN_DETAIL_STAT_FIELDS.filter((field) =>
    !sources.some((source) => aliases[field].some((alias) => Object.prototype.hasOwnProperty.call(source, alias)))
  );
}

function douyinSnapshotMissingFields(object: Record<string, unknown>): DouyinDetailStatField[] {
  const fields = [ ["likeCount", "digg_count", "likes"], ["commentCount", "comment_count", "comments"], ["favoriteCount", "collect_count", "favorites"], ["shareCount", "share_count", "shares"] ] as const;
  return fields.filter(([key, source]) =>
    object[key] == null || object[key] === "" || !Number.isFinite(Number(object[key])) || Number(object[key]) < 0 ||
    (Array.isArray(object.missingFields) && object.missingFields.includes(source))
  ).map(([, , field]) => field);
}
