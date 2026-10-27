import path from "path";
import { randomUUID } from "crypto";
import {
  createHotlistSurgeState,
  getHotlistSurgeDecision,
  isHotlistSurgeActive,
  isHotlistSurgeEligible,
  isHotlistSurgeStateAboveThreshold,
  shouldRetainHotlistSurgeState
} from "../douyin-hotlist-surge";
import type { Account, DouyinHotlistGroup, Platform, Video, VideoHotlistSurgeState, VideoHotlistTrend } from "../types";
import { calculateHotlistBaseScore, HOTLIST_SCORE_VERSION } from "../douyin-hotlist-score";
import { nowIso, safeSegment, shortHash } from "../utils";
import { libraryRoot, normalizeStorageSegment } from "./core";
import { readJsonFile, storageFs as fs, writeJsonFile } from "./fs";
import { withMutationLock } from "./mutation-lock";
import { douyinHotlistWatchlistSchema, parseStoredRecord, versionStoredRecord } from "./schemas";

const HOTLIST_DIR = "douyin-hotlist";
const ACCOUNTS_DIR = "accounts";
const WATCHLIST_FILE = "watchlist.json";

type DouyinHotlistWatchlist = {
  version: 1;
  accountIds: string[];
  groups?: DouyinHotlistGroup[];
  groupRevision?: number;
  updatedAt: string;
  lastRefreshedAt?: string;
  lastFullRefreshAttemptAt?: string;
  lastFullRefreshAt?: string;
};

type HotlistVideoCacheEntry = {
  mtimeMs: number;
  videos: Video[];
};

const globalHotlistStorage = globalThis as typeof globalThis & {
  __styleWorkbenchHotlistVideoCache?: Map<string, HotlistVideoCacheEntry>;
};

const hotlistVideoCache = globalHotlistStorage.__styleWorkbenchHotlistVideoCache ?? new Map<string, HotlistVideoCacheEntry>();
globalHotlistStorage.__styleWorkbenchHotlistVideoCache = hotlistVideoCache;

const queues = new Map<string, Promise<unknown>>();

function hotlistPath() {
  return path.join(libraryRoot(), HOTLIST_DIR);
}

function hotlistAccountsPath() {
  return path.join(hotlistPath(), ACCOUNTS_DIR);
}

function watchlistPath() {
  return path.join(hotlistPath(), WATCHLIST_FILE);
}

function hotlistAccountPath(slug: string) {
  return path.join(hotlistAccountsPath(), normalizeStorageSegment(slug, "视频热榜账号 ID"));
}

function hotlistAccountJsonPath(slug: string) {
  return path.join(hotlistAccountPath(slug), "account.json");
}

function hotlistVideosPath(slug: string) {
  return path.join(hotlistAccountPath(slug), "videos");
}

function hotlistVideoJsonPath(slug: string, videoId: string) {
  return path.join(hotlistVideosPath(slug), `${normalizeStorageSegment(videoId, "热榜视频 ID")}.json`);
}

export async function ensureDouyinHotlistDirs() {
  await fs.mkdir(hotlistAccountsPath(), { recursive: true });
}

async function ensureDouyinHotlistAccountDirs(slug: string) {
  await fs.mkdir(hotlistVideosPath(slug), { recursive: true });
}

export async function readDouyinHotlistWatchlist(): Promise<DouyinHotlistWatchlist> {
  return withHotlistWatchlistLock(readDouyinHotlistWatchlistUnlocked);
}

async function readDouyinHotlistWatchlistUnlocked(): Promise<DouyinHotlistWatchlist> {
  const file = await readJsonFile<unknown>(watchlistPath());
  if (!file) {
    return {
      version: 1,
      accountIds: [],
      updatedAt: nowIso()
    };
  }

  const parsed = douyinHotlistWatchlistSchema.safeParse(file);
  if (!parsed.success) throw new Error("视频热榜 watchlist 格式损坏，请备份并检查 douyin-hotlist/watchlist.json；未覆盖原文件");
  return { ...parsed.data, accountIds: normalizeDouyinHotlistAccountIds(parsed.data.accountIds) };
}

export async function addDouyinHotlistAccountRef(accountId: string) {
  return withHotlistWatchlistLock(async () => {
    const current = await readDouyinHotlistWatchlistUnlocked();
    const next = {
      ...current,
      accountIds: normalizeDouyinHotlistAccountIds([...current.accountIds, accountId]),
      updatedAt: nowIso()
    };
    await writeJsonFile(watchlistPath(), versionStoredRecord(next));
    return next;
  });
}

export async function removeDouyinHotlistAccountRefs(accountIds: string[]) {
  return withHotlistWatchlistLock(async () => {
    const removed = new Set(normalizeDouyinHotlistAccountIds(accountIds));
    const current = await readDouyinHotlistWatchlistUnlocked();
    const next = {
      ...current,
      accountIds: current.accountIds.filter((accountId) => !removed.has(accountId)),
      groups: current.groups?.map((group) => ({ ...group, accountIds: group.accountIds.filter((id) => !removed.has(id)) })),
      groupRevision: (current.groupRevision ?? 0) + 1,
      updatedAt: nowIso()
    };
    await writeJsonFile(watchlistPath(), versionStoredRecord(next));
    return next;
  });
}

export async function saveDouyinHotlistGroup(input: {
  id?: string; name: string; accountIds: string[]; revision: number;
}) {
  return withHotlistWatchlistLock(async () => {
    const current = await readDouyinHotlistWatchlistUnlocked();
    const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
    if (input.revision !== (current.groupRevision ?? 0)) fail("分组已被其他操作更新，请重载后再保存。", 409);
    const name = input.name.trim();
    if (!name || name.length > 40) fail("分组名称请输入 1–40 个字符。", 400);
    const groups = current.groups ?? [];
    if (input.id && !groups.some((group) => group.id === input.id)) fail("该分组不存在，请重载后再试。", 404);
    if (groups.some((group) => group.id !== input.id && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) fail("已有同名分组，请换个名字。", 400);
    const accountIds = normalizeDouyinHotlistAccountIds(input.accountIds);
    if (accountIds.some((id) => !current.accountIds.includes(id))) fail("部分账号已移出监控池，请重载后重新选择。", 409);
    const group = { id: input.id ?? randomUUID(), name, accountIds };
    const next = {
      ...current,
      groups: input.id ? groups.map((item) => item.id === input.id ? group : item) : [...groups, group],
      groupRevision: (current.groupRevision ?? 0) + 1,
      updatedAt: nowIso()
    };
    await writeJsonFile(watchlistPath(), versionStoredRecord(next));
    return group;
  });
}

export async function deleteDouyinHotlistGroup(input: { id: string; revision: number }) {
  return withHotlistWatchlistLock(async () => {
    const current = await readDouyinHotlistWatchlistUnlocked();
    if (input.revision !== (current.groupRevision ?? 0)) {
      throw Object.assign(new Error("分组已被其他操作更新，请重载后再删除。"), { status: 409 });
    }
    if (!current.groups?.some((group) => group.id === input.id)) {
      throw Object.assign(new Error("该分组不存在，请重载后再试。"), { status: 404 });
    }
    await writeJsonFile(watchlistPath(), versionStoredRecord({
      ...current,
      groups: current.groups.filter((group) => group.id !== input.id),
      groupRevision: (current.groupRevision ?? 0) + 1,
      updatedAt: nowIso()
    }));
  });
}

export async function recordDouyinHotlistRefresh(input: {
  attemptedAt?: string;
  changed: boolean;
  full: boolean;
  successful: boolean;
}) {
  return withHotlistWatchlistLock(async () => {
    const current = await readDouyinHotlistWatchlistUnlocked();
    const attemptedAt = input.attemptedAt || nowIso();
    const next: DouyinHotlistWatchlist = {
      ...current,
      updatedAt: attemptedAt,
      ...(input.changed ? { lastRefreshedAt: attemptedAt } : {}),
      ...(input.full ? { lastFullRefreshAttemptAt: attemptedAt } : {}),
      ...(input.full && input.successful ? { lastFullRefreshAt: attemptedAt } : {})
    };
    await writeJsonFile(watchlistPath(), versionStoredRecord(next));
    return next;
  });
}

export function withDouyinHotlistMutationLock<T>(run: () => Promise<T>) {
  return withMutationLock(queues, hotlistAccountsPath(), run);
}

export async function resolveDouyinHotlistAccount(accountIdOrSlug: string) {
  if (accountIdOrSlug.includes(":") && !accountIdOrSlug.startsWith("douyin-hotlist:")) {
    throw new Error(`视频热榜包含旧版账号引用 ${accountIdOrSlug}，请显式迁移到独立热榜账号库；读取不会修改素材`);
  }
  const slug = normalizeDouyinHotlistAccountSlug(accountIdOrSlug);
  return readHotlistRecord<Account>(hotlistAccountJsonPath(slug), "account");
}

export async function findDouyinHotlistAccountByName(platform: Platform, name: string) {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) return null;

  for (const slug of await readDouyinHotlistAccountSlugs()) {
    const account = await readHotlistRecord<Account>(hotlistAccountJsonPath(slug), "account");
    if (account?.platform === platform && account.name.trim().toLowerCase() === normalizedName) return account;
  }

  return null;
}

export async function findDouyinHotlistAccountByUid(platform: Platform, uid: string) {
  const normalizedUid = uid.trim();
  if (!normalizedUid) return null;

  for (const slug of await readDouyinHotlistAccountSlugs()) {
    const account = await readHotlistRecord<Account>(hotlistAccountJsonPath(slug), "account");
    if (account?.platform === platform && account.uid === normalizedUid) return account;
  }

  return null;
}

export async function upsertDouyinHotlistAccount(input: {
  platform: Platform;
  name: string;
  uid: string;
  sourceUrl?: string;
  avatarUrl?: string;
  lastCollectedAt?: string;
}) {
  await ensureDouyinHotlistDirs();
  const existing = await findDouyinHotlistAccountByUid(input.platform, input.uid);
  const now = nowIso();
  const slug = existing?.slug ? normalizeDouyinHotlistAccountSlug(existing.slug) : createHotlistSlug(input.platform, input.name || input.uid, input.uid);
  await ensureDouyinHotlistAccountDirs(slug);

  const account: Account = {
    id: `douyin-hotlist:${slug}`,
    slug,
    platform: input.platform,
    name: input.name || existing?.name || input.uid,
    uid: input.uid,
    sourceUrl: input.sourceUrl || existing?.sourceUrl,
    avatarUrl: input.avatarUrl || existing?.avatarUrl,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastCollectedAt: input.lastCollectedAt ?? existing?.lastCollectedAt
  };

  await writeJsonFile(hotlistAccountJsonPath(slug), versionStoredRecord(account));
  return account;
}

export async function getDouyinHotlistAccountVideos(account: Account, options: { force?: boolean } = {}) {
  const videosPath = hotlistVideosPath(account.slug);
  const initialStat = await fs.stat(videosPath).catch(missingDirectory);
  if (!initialStat) return [];
  const cached = hotlistVideoCache.get(videosPath);
  if (!options.force && cached?.mtimeMs === initialStat.mtimeMs) return cached.videos;

  const files = await fs.readdir(videosPath);
  const videos = (
    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readHotlistRecord<Video>(path.join(videosPath, file), "video"))
    )
  ).filter(Boolean) as Video[];

  const sorted = videos.sort((left, right) => right.hotScore - left.hotScore);
  const finalStat = await fs.stat(videosPath);
  if (initialStat.mtimeMs === finalStat.mtimeMs) hotlistVideoCache.set(videosPath, { mtimeMs: initialStat.mtimeMs, videos: sorted });
  return sorted;
}

export async function saveDouyinHotlistVideos(account: Account, incoming: Video[]) {
  await ensureDouyinHotlistAccountDirs(account.slug);
  const averageViews =
    incoming.reduce((sum, video) => sum + (video.stats.views || 0), 0) /
      Math.max(incoming.filter((video) => video.stats.views > 0).length, 1) || 0;
  const saved: Video[] = [];
  let changedCount = 0;

  for (const video of incoming) {
    const id = safeSegment(video.id, shortHash(`${video.title}-${video.url}`));
    const existing = await readHotlistRecord<Video>(hotlistVideoJsonPath(account.slug, id), "video");
    const mergedStats = mergeVideoStats(existing, video);
    const publishedAt = video.publishedAt || existing?.publishedAt;
    const normalizedVideo = publishedAt === video.publishedAt ? video : { ...video, publishedAt };
    const hotScore = calculateHotlistBaseScore({ ...video, stats: mergedStats });
    if (hasMeaningfulVideoChange(existing, normalizedVideo, mergedStats)) changedCount += 1;
    const updatedAt = nowIso();
    const hotlistTrend = buildHotlistTrend(existing, hotScore, updatedAt);
    const nextBase: Video = {
      ...existing,
      ...normalizedVideo,
      id,
      accountId: account.id,
      platform: account.platform,
      stats: mergedStats,
      hotScore,
      hotScoreVersion: HOTLIST_SCORE_VERSION,
      relativeViewRate:
        mergedStats.views > 0 && averageViews > 0 ? Number((mergedStats.views / averageViews).toFixed(2)) : 0,
      transcriptStatus: existing?.transcriptStatus ?? video.transcriptStatus,
      transcriptPath: existing?.transcriptPath ?? video.transcriptPath,
      transcriptSource: existing?.transcriptSource ?? video.transcriptSource,
      hotlistTrend,
      hotlistSurge: undefined,
      updatedAt
    };
    const next: Video = {
      ...nextBase,
      hotlistSurge: resolveHotlistSurgeState(existing?.hotlistSurge, hotlistTrend, existing?.hotlistTrend, updatedAt, nextBase)
    };

    await writeJsonFile(hotlistVideoJsonPath(account.slug, id), versionStoredRecord(next));
    saved.push(next);
  }

  hotlistVideoCache.delete(hotlistVideosPath(account.slug));
  return {
    videos: saved.sort((left, right) => right.hotScore - left.hotScore),
    changedCount,
    observedCount: incoming.length
  };
}

async function readDouyinHotlistAccountSlugs() {
  const entries = await fs.readdirEntries(hotlistAccountsPath()).catch(error => missingDirectory(error) ?? []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function normalizeDouyinHotlistAccountIds(accountIds: string[]) {
  return [...new Set(accountIds.map(normalizeDouyinHotlistAccountId).filter(Boolean))];
}

function normalizeDouyinHotlistAccountId(accountId: string) {
  const [scope, rawSlug, extra] = accountId.split(":");
  if (!["douyin-hotlist", "douyin"].includes(scope) || !rawSlug || extra !== undefined) throw new Error(`视频热榜账号引用无效：${accountId}`);
  return `${scope}:${normalizeStorageSegment(rawSlug, "视频热榜账号 ID")}`;
}

function normalizeDouyinHotlistAccountSlug(accountIdOrSlug: string) {
  const slug = accountIdOrSlug.includes(":") ? accountIdOrSlug.split(":").at(-1)! : accountIdOrSlug;
  return normalizeStorageSegment(slug, "视频热榜账号 ID");
}

function createHotlistSlug(platform: Platform, name: string, uid: string) {
  return normalizeStorageSegment(`${platform}-${safeSegment(name, "account")}-${shortHash(uid)}`, "视频热榜账号 ID");
}

function mergeVideoStats(existing: Video | null, incoming: Video) {
  if (!existing) return incoming.stats;
  return {
    views: pickPreferredMetric(existing.stats.views, incoming.stats.views),
    likes: pickPreferredMetric(existing.stats.likes, incoming.stats.likes),
    comments: pickPreferredMetric(existing.stats.comments, incoming.stats.comments),
    favorites: pickPreferredMetric(existing.stats.favorites, incoming.stats.favorites),
    shares: pickPreferredMetric(existing.stats.shares, incoming.stats.shares)
  };
}

function pickPreferredMetric(existing?: number, incoming?: number) {
  const safeExisting = Number.isFinite(existing) ? Number(existing) : 0;
  const safeIncoming = Number.isFinite(incoming) ? Number(incoming) : 0;
  return safeIncoming > 0 ? safeIncoming : safeExisting;
}

function buildHotlistTrend(existing: Video | null, currentHotScore: number, updatedAt: string): VideoHotlistTrend | undefined {
  if (!existing?.updatedAt || existing.hotScoreVersion !== HOTLIST_SCORE_VERSION) return undefined;

  const previousTime = new Date(existing.updatedAt).getTime();
  const currentTime = new Date(updatedAt).getTime();
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime) || currentTime <= previousTime) {
    return undefined;
  }

  const previousHotScore = Number.isFinite(existing.hotScore) ? existing.hotScore : calculateHotlistBaseScore(existing);
  const intervalHours = (currentTime - previousTime) / 3_600_000;

  return {
    previousHotScore,
    currentHotScore,
    heatDelta: currentHotScore - previousHotScore,
    intervalHours: roundTo(intervalHours, 2),
    previousUpdatedAt: existing.updatedAt,
    updatedAt
  };
}

function resolveHotlistSurgeState(
  existing: VideoHotlistSurgeState | undefined,
  trend: VideoHotlistTrend | undefined,
  previousTrend: VideoHotlistTrend | undefined,
  updatedAt: string,
  video: Video
): VideoHotlistSurgeState | undefined {
  const ageHours = getVideoAgeHours(video, updatedAt);
  if (!isHotlistSurgeEligible({ ageHours, hotScore: video.hotScore, platform: video.platform, stats: video.stats })) return undefined;

  const decision = getHotlistSurgeDecision(trend, video.platform);
  if (decision) return createHotlistSurgeState(decision, updatedAt);

  if (!shouldRetainHotlistSurgeState(video.platform)) return undefined;

  const updatedTime = new Date(updatedAt).getTime();
  const now = Number.isFinite(updatedTime) ? updatedTime : Date.now();
  if (isHotlistSurgeActive(existing, now) && isHotlistSurgeStateAboveThreshold(existing, video.platform)) return existing;

  const previousDecision = getHotlistSurgeDecision(previousTrend, video.platform);
  if (previousDecision && previousTrend?.updatedAt) {
    const carried = createHotlistSurgeState(previousDecision, previousTrend.updatedAt);
    if (isHotlistSurgeActive(carried, now)) return carried;
  }

  return undefined;
}

function getVideoAgeHours(video: Video, referenceIso: string) {
  if (!video.publishedAt) return undefined;
  const publishedTime = new Date(video.publishedAt).getTime();
  const referenceTime = new Date(referenceIso).getTime();
  if (!Number.isFinite(publishedTime) || !Number.isFinite(referenceTime)) return undefined;
  return Math.max(0, (referenceTime - publishedTime) / 3_600_000);
}

function hasMeaningfulVideoChange(existing: Video | null, incoming: Video, stats: Video["stats"]) {
  if (!existing) return true;
  return (
    existing.title !== incoming.title ||
    existing.url !== incoming.url ||
    existing.coverUrl !== incoming.coverUrl ||
    existing.publishedAt !== incoming.publishedAt ||
    existing.stats.views !== stats.views ||
    existing.stats.likes !== stats.likes ||
    existing.stats.comments !== stats.comments ||
    existing.stats.favorites !== stats.favorites ||
    (existing.stats.shares ?? 0) !== (stats.shares ?? 0)
  );
}

function withHotlistWatchlistLock<T>(run: () => Promise<T>) {
  return withMutationLock(queues, watchlistPath(), run);
}

async function readHotlistRecord<T>(target: string, kind: "account" | "video"): Promise<T | null> {
  const value = await readJsonFile<unknown>(target);
  return value === null ? null : parseStoredRecord<T>(target, value, kind);
}

function missingDirectory(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw new Error("读取视频热榜目录失败，请检查目录和读取权限", { cause: error });
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
