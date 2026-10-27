import { mapWithConcurrency } from "./concurrency";
import { withMutationLock } from "./storage/mutation-lock";
import { type Dirent } from "fs";
import { createHash, randomUUID } from "crypto";
import path from "path";
import {
  Account,
  AccountDetail,
  AccountDraft,
  AccountListItem,
  AccountSummary,
  CopySource,
  Draft,
  DraftAssets,
  DraftInput,
  DraftSummary,
  EngagementRecord,
  EngagementRecordSummary,
  LibraryOverviewResponse,
  Platform,
  Project,
  ProjectDraft,
  ProjectListItem,
  ProjectSummary,
  TranscriptVersion,
  Video,
  VideoListItem,
  WriteStyleReference,
  platforms
} from "./types";
import { makeDraftTitleFromContent, nowIso, safeSegment, shortHash } from "./utils";
import { fileExists, readJsonFile, storageFs as fs, writeJsonFile, writeTextFileAtomic } from "./storage/fs";
import { libraryRoot, normalizeStorageSegment, toLibraryRelativePath } from "./storage/core";
import { ensureDouyinHotlistDirs } from "./storage/douyin-hotlist";
import { ensureGrossMarginDirs } from "./storage/gross-margin";
import { parseStoredRecord, storedRecordKind, versionStoredRecord } from "./storage/schemas";
import { runRecoverableLibraryMutation } from "./storage/transactions";
export { libraryRoot } from "./storage/core";
export { listLibraryTrashOperations, restoreLibraryTrashOperation } from "./storage/transactions";
export {
  appendGrossMarginPlaySample,
  deleteGrossMarginMonitorRecord,
  getGrossMarginLibrary,
  getGrossMarginMonitorRecords,
  getGrossMarginReviewTemplate,
  resolveGrossMarginMonitorRecord,
  saveGrossMarginMonitorRecord,
  saveGrossMarginPriceTable,
  saveGrossMarginReviewTemplate,
  updateGrossMarginMonitorRecord,
  upsertGrossMarginMonitorRecord,
} from "./storage/gross-margin";

const DEFAULT_STYLE = `# 风格卡

## 内容定位
- 暂未总结。

## 开头方式
- 暂未总结。

## 句式与节奏
- 暂未总结。

## 常用话术
- 暂未总结。

## 结尾方式
- 暂未总结。
`;

// 占位卡可能来自旧模板（例如标题写作「结尾 CTA」），不能只比较 DEFAULT_STYLE；
// 按内容判断：去掉标题、列表符号和标点后，没有任何非占位正文就算未生成。
export function isPlaceholderStyle(text: string) {
  const body = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^([-*+]|\d+[.)])\s*/, "").replace(/[。，、；：！？…\s]/g, ""))
    .filter(Boolean);
  return body.every((line) => /^(暂未总结|待补充|暂无|无|待定)$/.test(line));
}

const draftAssetQueues = new Map<string, Promise<unknown>>();
const engagementRecordQueues = new Map<string, Promise<unknown>>();
const engagementCacheQueues = new Map<string, Promise<unknown>>();
const identityMutationQueues = new Map<string, Promise<unknown>>();
// ponytail: queues cover one process; multiple writer processes need a filesystem lock.
const globalStorage = globalThis as typeof globalThis & {
  __styleWorkbenchVideoMutationQueues?: Map<string, Promise<unknown>>;
};
const videoMutationQueues = globalStorage.__styleWorkbenchVideoMutationQueues ||= new Map<string, Promise<unknown>>();

type DetailReadOptions = {
  includeStyle?: boolean;
};

export type EngagementCacheKind = "source" | "brief" | "research" | "samples" | "pipeline" | "model-calls";

export type AccountStyleMeta = {
  sampleHash: string;
  sampleFingerprints: Array<{
    videoId: string;
    hash: string;
  }>;
  sampleVideoIds: string[];
  sampleCount: number;
  generationMode: "full" | "incremental";
  usedModel: string;
  fallback?: boolean;
  fallbackReason?: string;
  updatedAt: string;
};

export type StyleSampleAnalysisCache = {
  version: 1;
  cacheKey: string;
  kind: "account-video" | "copy-source";
  sourceId: string;
  title: string;
  inputChars: number;
  analysis: string;
  evidence?: import("./writer-context").StyleEvidence;
  usedModel: string;
  reasoningEffort: string;
  requestedServiceTier?: string;
  actualServiceTier?: string;
  wireApi?: string;
  generatedAt: string;
};

function videoHasTranscript(video: Pick<Video, "transcriptStatus" | "transcriptPath">) {
  return video.transcriptStatus === "completed" || Boolean(video.transcriptPath);
}

function stripVideoRaw(video: Video): VideoListItem {
  const copy = { ...video };
  delete copy.raw;
  return copy;
}

function platformPath(platform: Platform) {
  return path.join(libraryRoot(), platform);
}

function projectsPath() {
  return path.join(libraryRoot(), "projects");
}

function copyToolsPath() {
  return path.join(libraryRoot(), "copy-tools");
}

function copySourcesPath() {
  return path.join(copyToolsPath(), "sources");
}

function engagementPath() {
  return path.join(libraryRoot(), "engagement");
}

function engagementCachePath(kind: EngagementCacheKind) {
  return path.join(engagementPath(), ".cache", kind);
}

function engagementCacheJsonPath(kind: EngagementCacheKind, cacheKey: string) {
  return path.join(engagementCachePath(kind), `${normalizeStorageSegment(cacheKey, "评论缓存键")}.json`);
}

function engagementRecordJsonPath(id: string) {
  return path.join(engagementPath(), `${id}.json`);
}

function copySourceJsonPath(id: string) {
  return path.join(copySourcesPath(), `${id}.json`);
}

function copySourceTranscriptPath(id: string) {
  return path.join(copySourcesPath(), `${id}.txt`);
}

function projectPath(slug: string) {
  return path.join(projectsPath(), slug);
}

function projectJsonPath(slug: string) {
  return path.join(projectPath(slug), "project.json");
}

function projectStylePath(slug: string) {
  return path.join(projectPath(slug), "style.md");
}

function projectDraftsPath(slug: string) {
  return path.join(projectPath(slug), "drafts");
}

function projectDraftAssetsPath(slug: string, draftId: string) {
  return path.join(projectDraftsPath(slug), `${safeSegment(draftId)}.assets`);
}

function accountPath(platform: Platform, slug: string) {
  return path.join(platformPath(platform), slug);
}

function accountJsonPath(platform: Platform, slug: string) {
  return path.join(accountPath(platform, slug), "account.json");
}

function videosPath(platform: Platform, slug: string) {
  return path.join(accountPath(platform, slug), "videos");
}

function transcriptsPath(platform: Platform, slug: string) {
  return path.join(accountPath(platform, slug), "transcripts");
}

function transcriptHistoryPath(platform: Platform, slug: string, videoId: string) {
  return path.join(transcriptsPath(platform, slug), ".history", normalizeVideoId(videoId));
}

function draftsPath(platform: Platform, slug: string) {
  return path.join(accountPath(platform, slug), "drafts");
}

function draftAssetsPath(platform: Platform, slug: string, draftId: string) {
  return path.join(draftsPath(platform, slug), `${safeSegment(draftId)}.assets`);
}

function stylePath(platform: Platform, slug: string) {
  return path.join(accountPath(platform, slug), "style.md");
}

function styleMetaPath(platform: Platform, slug: string) {
  return path.join(accountPath(platform, slug), "style.meta.json");
}

function accountStyleSamplesPath(platform: Platform, slug: string) {
  return path.join(accountPath(platform, slug), "style-samples");
}

function accountStyleSampleAnalysisPath(platform: Platform, slug: string, videoId: string) {
  return path.join(accountStyleSamplesPath(platform, slug), `${normalizeVideoId(videoId)}.json`);
}

function normalizeAccountSlug(accountIdOrSlug: string) {
  const slug = accountIdOrSlug.includes(":") ? accountIdOrSlug.split(":").at(-1)! : accountIdOrSlug;
  return normalizeStorageSegment(slug, "账号 ID");
}

function normalizeProjectSlug(projectIdOrSlug: string) {
  const slug = projectIdOrSlug.includes(":") ? projectIdOrSlug.split(":").at(-1)! : projectIdOrSlug;
  return normalizeStorageSegment(slug, "项目 ID");
}

function normalizeVideoId(videoId: string) {
  return normalizeStorageSegment(videoId, "视频 ID");
}

function normalizeDraftId(draftId: string) {
  return normalizeStorageSegment(draftId, "草稿 ID");
}

function normalizeDraftTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("草稿名称不能为空");
  }
  return normalized;
}

function normalizeCopySourceId(sourceId: string) {
  return normalizeStorageSegment(sourceId, "文案素材 ID");
}

function createStorageSlug(value: string, fallback: string, label: string) {
  return normalizeStorageSegment(safeSegment(value, fallback), label);
}

async function createAvailableAccountSlug(platform: Platform, name: string, uid: string) {
  const base = createStorageSlug(name, shortHash(uid), "账号 ID");
  const baseAccount = await readJson<Account>(accountJsonPath(platform, base));
  if (baseAccount?.uid === uid) return base;
  if (!baseAccount && !(await exists(accountPath(platform, base)))) return base;

  const hashedBase = createStorageSlug(`${base}-${shortHash(uid)}`, shortHash(uid), "账号 ID");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt ? `${hashedBase}-${attempt + 1}` : hashedBase;
    const account = await readJson<Account>(accountJsonPath(platform, candidate));
    if (account?.uid === uid) return candidate;
    if (!account && !(await exists(accountPath(platform, candidate)))) return candidate;
  }

  throw new Error(`无法为账号「${name}」分配唯一目录，请检查现有账号目录。`);
}

function isFsErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

async function readDirNamesIfExists(target: string) {
  try {
    return await fs.readdir(target);
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return [];
    throw new Error(`读取目录失败：${target}。${error instanceof Error ? error.message : "文件系统异常"}`);
  }
}

async function readDirEntriesIfExists(target: string): Promise<Array<Pick<Dirent, "name" | "isFile" | "isDirectory">>> {
  try {
    return await fs.readdirEntries(target);
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return [];
    throw new Error(`读取目录失败：${target}。${error instanceof Error ? error.message : "文件系统异常"}`);
  }
}

async function readTextOrDefaultIfMissing(target: string, fallback: string) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return fallback;
    throw new Error(`读取文本文件失败：${target}。${error instanceof Error ? error.message : "文件系统异常"}`);
  }
}

async function statIfExists(target: string) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return null;
    throw new Error(`读取文件状态失败：${target}。${error instanceof Error ? error.message : "文件系统异常"}`);
  }
}

function normalizeEngagementRecordId(recordId: string) {
  return normalizeStorageSegment(recordId, "互动素材 ID");
}

async function withDraftAssetsLock<T>(draftId: string, run: () => Promise<T>) {
  return withMutationLock(draftAssetQueues, draftId, run);
}

async function withEngagementRecordLock<T>(recordId: string, run: () => Promise<T>) {
  return withMutationLock(engagementRecordQueues, recordId, run);
}

async function withIdentityMutationLock<T>(key: string, run: () => Promise<T>) {
  return withMutationLock(identityMutationQueues, key, run);
}

async function withVideoMutationLock<T>(key: string, run: () => Promise<T>) {
  return withMutationLock(videoMutationQueues, key, run);
}

async function exists(target: string) {
  return fileExists(target);
}

async function readJson<T>(target: string): Promise<T | null> {
  const value = await readJsonFile<unknown>(target);
  if (value === null) return null;
  const kind = storedRecordKind(target, libraryRoot());
  return kind ? parseStoredRecord<T>(target, value, kind) : value as T;
}

async function writeJson(target: string, value: unknown) {
  const kind = storedRecordKind(target, libraryRoot());
  if (!kind) return writeJsonFile(target, value);
  const versioned = versionStoredRecord(value);
  return writeJsonFile(target, parseStoredRecord(target, versioned, kind));
}

async function ensureAccountDirs(platform: Platform, slug: string) {
  await fs.mkdir(videosPath(platform, slug), { recursive: true });
  await fs.mkdir(transcriptsPath(platform, slug), { recursive: true });
  await fs.mkdir(draftsPath(platform, slug), { recursive: true });

  const style = stylePath(platform, slug);
  if (!(await exists(style))) {
    await writeTextFileAtomic(style, DEFAULT_STYLE);
  }
}

async function ensureProjectDirs(slug: string) {
  await fs.mkdir(projectDraftsPath(slug), { recursive: true });

  const style = projectStylePath(slug);
  if (!(await exists(style))) {
    await writeTextFileAtomic(style, DEFAULT_STYLE);
  }
}

export async function ensureLibrary() {
  await fs.mkdir(libraryRoot(), { recursive: true });
  await Promise.all([
    ...platforms.map((platform) => fs.mkdir(platformPath(platform), { recursive: true })),
    fs.mkdir(engagementPath(), { recursive: true }),
    ensureDouyinHotlistDirs(),
    ensureGrossMarginDirs()
  ]);
}

export async function resolveAccount(platform: Platform, accountIdOrSlug: string) {
  await ensureLibrary();
  const slug = normalizeAccountSlug(accountIdOrSlug);
  const account = await readJson<Account>(accountJsonPath(platform, slug));
  if (!account) {
    throw new Error(`找不到账号：${platform}/${slug}`);
  }
  return account;
}

async function findExistingAccount(platform: Platform, uid: string) {
  const base = platformPath(platform);
  const entries = await readDirEntriesIfExists(base);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const account = await readJson<Account>(accountJsonPath(platform, entry.name));
    if (account?.uid === uid) return account;
  }

  return null;
}

export async function findAccountByUid(platform: Platform, uid: string) {
  await ensureLibrary();
  return findExistingAccount(platform, uid);
}

export async function findAccountByName(platform: Platform, name: string) {
  await ensureLibrary();
  const base = platformPath(platform);
  const entries = await readDirEntriesIfExists(base);
  const normalizedName = name.trim().toLowerCase();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const account = await readJson<Account>(accountJsonPath(platform, entry.name));
    if (account?.name.trim().toLowerCase() === normalizedName) return account;
  }

  return null;
}

export async function upsertAccount(input: {
  platform: Platform;
  name: string;
  uid: string;
  sourceUrl?: string;
  avatarUrl?: string;
  lastCollectedAt?: string;
}) {
  await ensureLibrary();
  return withIdentityMutationLock(`accounts:${input.platform}`, async () => {
    const existing = await findExistingAccount(input.platform, input.uid);
    const now = nowIso();
    const slug = existing?.slug
      ? normalizeAccountSlug(existing.slug)
      : await createAvailableAccountSlug(input.platform, input.name || input.uid, input.uid);

    const account: Account = {
      id: `${input.platform}:${slug}`,
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

    await writeJson(accountJsonPath(input.platform, slug), account);
    await ensureAccountDirs(input.platform, slug);
    return account;
  });
}

export async function deleteAccounts(accountIds: string[]) {
  await ensureLibrary();
  const uniqueIds = [...new Set(accountIds)].filter(Boolean);
  const deleted: string[] = [];
  const targets: string[] = [];

  for (const accountId of uniqueIds) {
    const [platform, slug] = accountId.split(":") as [Platform, string];
    if (!platforms.includes(platform) || !slug) continue;
    const normalizedSlug = normalizeAccountSlug(slug);
    const target = accountPath(platform, normalizedSlug);
    if (!(await exists(target))) continue;
    targets.push(target);
    deleted.push(`${platform}:${normalizedSlug}`);
  }

  if (!deleted.length) return { deleted };
  const backupTargets = await collectProjectAndDraftJsonPaths();
  const transaction = await runRecoverableLibraryMutation({
    kind: "delete-accounts",
    targets,
    backupTargets,
    run: async () => {
      await removeDeletedAccountsFromProjects(deleted);
      await updateAllDraftStyleRefs((styleRefs) => removeDeletedAccountsFromStyleRefs(styleRefs, new Set(deleted)));
      return deleted;
    }
  });

  return { deleted: transaction.result, trashOperationId: transaction.operation.id };
}

export async function getCopySources() {
  await ensureLibrary();
  const files = await readDirNamesIfExists(copySourcesPath());
  const sources = (
    await Promise.all(
      files
        .filter((file) => file.endsWith(".json") && !file.endsWith(".style-analysis.json"))
        .map((file) => readJson<CopySource>(path.join(copySourcesPath(), file)))
    )
  )
    .filter(Boolean)
    .map((source) => normalizeCopySource(source as CopySource));

  return sources.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function resolveCopySource(sourceId: string) {
  await ensureLibrary();
  const id = normalizeCopySourceId(sourceId);
  const source = await readJson<CopySource>(copySourceJsonPath(id));
  if (!source) {
    throw new Error(`找不到文案素材：${id}`);
  }
  return normalizeCopySource(source);
}

export async function saveEngagementRecord(input: Omit<EngagementRecord, "id" | "createdAt" | "updatedAt">, options: { idempotencyKey?: string } = {}) {
  await ensureLibrary();
  const now = nowIso();
  const id = options.idempotencyKey ? `run-${shortHash(options.idempotencyKey)}` : `${now.replace(/[:.]/g, "-")}-${shortHash(`${input.sourceType}-${input.title}-${input.sourceText}`)}`;
  return withEngagementRecordLock(id, async () => {
    const existing = options.idempotencyKey ? await readJson<EngagementRecord>(engagementRecordJsonPath(id)) : null;
    if (existing && (existing.comments?.items.length || 0) >= (input.comments?.items.length || 0)
      && (existing.danmaku?.items.length || 0) >= (input.danmaku?.items.length || 0)) return existing;
    const comments = existing?.comments && existing.comments.items.length > (input.comments?.items.length || 0)
      ? existing.comments : input.comments || existing?.comments;
    const danmaku = existing?.danmaku && existing.danmaku.items.length > (input.danmaku?.items.length || 0)
      ? existing.danmaku : input.danmaku || existing?.danmaku;
    const record: EngagementRecord = {
      ...input,
      comments,
      danmaku,
      id,
      title: makeDraftTitleFromContent(input.title || input.sourceText, "互动素材"),
      sourceText: input.sourceText.trim(),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    await writeJson(engagementRecordJsonPath(id), record);
    return record;
  });
}

export async function updateEngagementRecord(
  recordId: string,
  update: (current: EngagementRecord) => EngagementRecord | Promise<EngagementRecord>
) {
  await ensureLibrary();
  const id = normalizeEngagementRecordId(recordId);
  return withEngagementRecordLock(id, async () => {
    const current = await readJson<EngagementRecord>(engagementRecordJsonPath(id));
    if (!current) throw new Error(`找不到互动素材：${id}`);
    const updated = await update(current);
    const next: EngagementRecord = {
      ...updated,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: nowIso()
    };
    await writeJson(engagementRecordJsonPath(id), next);
    return next;
  });
}

export async function readEngagementCache<T>(kind: EngagementCacheKind, cacheKey: string) {
  await ensureLibrary();
  return readJson<T>(engagementCacheJsonPath(kind, cacheKey));
}

export async function writeEngagementCache(kind: EngagementCacheKind, cacheKey: string, value: unknown) {
  await ensureLibrary();
  await writeJson(engagementCacheJsonPath(kind, cacheKey), value);
}

export async function updateEngagementCache<T>(
  kind: EngagementCacheKind,
  cacheKey: string,
  update: (current: T | null) => T | Promise<T>
) {
  await ensureLibrary();
  return withEngagementCacheLock(kind, cacheKey, async () => {
    const current = await readJson<T>(engagementCacheJsonPath(kind, cacheKey));
    const value = await update(current);
    await writeJson(engagementCacheJsonPath(kind, cacheKey), value);
    return value;
  });
}

export async function withEngagementCacheLock<T>(kind: EngagementCacheKind, cacheKey: string, run: () => Promise<T>) {
  const queueKey = `${kind}:${normalizeStorageSegment(cacheKey, "评论缓存键")}`;
  const previous = engagementCacheQueues.get(queueKey) || Promise.resolve();
  // 上一调用的错误已交还调用者，不阻塞后续任务获取同一把锁。
  const next = previous.catch(() => undefined).then(run);
  engagementCacheQueues.set(queueKey, next);
  try {
    return await next;
  } finally {
    if (engagementCacheQueues.get(queueKey) === next) engagementCacheQueues.delete(queueKey);
  }
}

export async function getEngagementRecords() {
  await ensureLibrary();
  const files = await readDirNamesIfExists(engagementPath());
  const records = (
    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson<EngagementRecord>(path.join(engagementPath(), file)))
    )
  ).filter(Boolean) as EngagementRecord[];

  return records.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function getEngagementRecordSummaries() {
  return (await getEngagementRecords()).map(toEngagementRecordSummary);
}

export function toEngagementRecordSummary(record: EngagementRecord): EngagementRecordSummary {
  return {
    id: record.id,
    sourceType: record.sourceType,
    title: record.title,
    sourceAccountName: record.sourceAccountName,
    sourceUrl: record.sourceUrl,
    platform: record.platform,
    draftId: record.draftId,
    fallback: record.fallback,
    fallbackReason: record.fallbackReason,
    commentCount: record.comments?.items.length || 0,
    danmakuCount: record.danmaku?.items.length || 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export async function resolveEngagementRecord(recordId: string) {
  await ensureLibrary();
  const id = normalizeEngagementRecordId(recordId);
  const record = await readJson<EngagementRecord>(engagementRecordJsonPath(id));
  if (!record) {
    throw new Error(`找不到互动素材：${id}`);
  }
  return record;
}

export async function deleteEngagementRecords(recordIds: string[]) {
  await ensureLibrary();
  const uniqueIds = [...new Set(recordIds)].filter(Boolean).map(normalizeEngagementRecordId);
  const deleted: string[] = [];
  const targets: string[] = [];

  for (const recordId of uniqueIds) {
    const target = engagementRecordJsonPath(recordId);
    if (!(await exists(target))) continue;
    targets.push(target);
    deleted.push(recordId);
  }

  if (!deleted.length) return { deleted };
  const transaction = await runRecoverableLibraryMutation({
    kind: "delete-engagement-records",
    targets,
    run: async () => deleted
  });
  return { deleted: transaction.result, trashOperationId: transaction.operation.id };
}

export async function saveVideos(account: Account, incoming: Video[]) {
  await ensureAccountDirs(account.platform, account.slug);
  const averageViews =
    incoming.reduce((sum, video) => sum + (video.stats.views || 0), 0) /
      Math.max(incoming.filter((video) => video.stats.views > 0).length, 1) || 0;

  const saved: Video[] = [];
  for (const video of incoming) {
    const id = safeSegment(video.id, shortHash(`${video.title}-${video.url}`));
    const lockKey = `${account.platform}:${account.slug}:${id}`;
    saved.push(await withVideoMutationLock(lockKey, async () => {
      const target = path.join(videosPath(account.platform, account.slug), `${id}.json`);
      const existing = await readJson<Video>(target);
      const transcriptFile = path.join(transcriptsPath(account.platform, account.slug), `${id}.txt`);
      const hasTranscript = await exists(transcriptFile);
      const mergedStats = mergeVideoStats(existing, video);
      const mergedTopComments =
        Array.isArray(video.topComments) && video.topComments.length
          ? video.topComments
          : existing?.topComments;
      const transcriptStatus = hasTranscript
        ? "completed"
        : normalizeTranscriptStatusWithoutFile(existing?.transcriptStatus ?? video.transcriptStatus);

      const next: Video = {
        ...existing,
        ...video,
        id,
        accountId: account.id,
        platform: account.platform,
        stats: mergedStats,
        topComments: mergedTopComments,
        hotScore: calculateHotScore({ ...video, stats: mergedStats }),
        relativeViewRate:
          mergedStats.views > 0 && averageViews > 0 ? Number((mergedStats.views / averageViews).toFixed(2)) : 0,
        transcriptStatus,
        transcriptPath: hasTranscript ? toLibraryRelativePath(transcriptFile) : undefined,
        transcriptSource: hasTranscript ? existing?.transcriptSource ?? video.transcriptSource : undefined,
        updatedAt: nowIso()
      };

      await writeJson(target, next);
      return next;
    }));
  }

  return saved.sort((a, b) => b.hotScore - a.hotScore);
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
  if (safeIncoming > 0) return safeIncoming;
  return safeExisting;
}

function normalizeTranscriptStatusWithoutFile(status: Video["transcriptStatus"]) {
  return status === "failed" ? "failed" : "not_started";
}

export async function saveVideo(account: Account, video: Video) {
  await ensureAccountDirs(account.platform, account.slug);
  const id = normalizeVideoId(video.id);
  const lockKey = `${account.platform}:${account.slug}:${id}`;
  return withVideoMutationLock(lockKey, async () => {
    const target = path.join(videosPath(account.platform, account.slug), `${id}.json`);
    const existing = await readJson<Video>(target);
    const transcriptFile = path.join(transcriptsPath(account.platform, account.slug), `${id}.txt`);
    const hasTranscript = await exists(transcriptFile);
    const stats = mergeVideoStats(existing, video);
    const next: Video = {
      ...existing,
      ...video,
      id,
      stats,
      hotScore: calculateHotScore({ ...video, stats }),
      transcriptStatus: hasTranscript
        ? "completed"
        : normalizeTranscriptStatusWithoutFile(existing?.transcriptStatus ?? video.transcriptStatus),
      transcriptPath: hasTranscript ? toLibraryRelativePath(transcriptFile) : undefined,
      transcriptRevision: hasTranscript ? existing?.transcriptRevision ?? video.transcriptRevision : undefined,
      transcriptSource: hasTranscript ? existing?.transcriptSource ?? video.transcriptSource : undefined,
      updatedAt: nowIso()
    };
    await writeJson(target, next);
    return next;
  });
}

export async function saveVideoAssetFields(
  platform: Platform,
  accountId: string,
  videoId: string,
  fields: Partial<Pick<Video, "coverUrl" | "danmakuSamples" | "topComments" | "raw">>
) {
  const account = await resolveAccount(platform, accountId);
  const normalizedVideoId = normalizeVideoId(videoId);
  const lockKey = `${account.platform}:${account.slug}:${normalizedVideoId}`;
  return withVideoMutationLock(lockKey, async () => {
    const target = path.join(videosPath(account.platform, account.slug), `${normalizedVideoId}.json`);
    const video = await readJson<Video>(target);
    if (!video) throw new Error("找不到视频元数据");

    const next: Video = {
      ...video,
      ...fields,
      updatedAt: nowIso()
    };
    await writeJson(target, next);
    return next;
  });
}

export async function saveTranscript(input: {
  platform: Platform;
  accountId: string;
  videoId: string;
  text: string;
  source: Video["transcriptSource"];
  expectedRevision?: string | null;
}) {
  const account = await resolveAccount(input.platform, input.accountId);
  await ensureAccountDirs(account.platform, account.slug);
  const videoId = normalizeVideoId(input.videoId);
  const lockKey = `${account.platform}:${account.slug}:${videoId}`;

  return withVideoMutationLock(lockKey, async () => {
    const videoFile = path.join(videosPath(account.platform, account.slug), `${videoId}.json`);
    const video = await readJson<Video>(videoFile);
    if (!video) throw new Error("找不到视频元数据");

    const transcriptFile = path.join(transcriptsPath(account.platform, account.slug), `${videoId}.txt`);
    const currentTranscript = await readTextIfExists(transcriptFile);
    const currentRevision = getTranscriptRevision(currentTranscript);
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw createTranscriptConflictError();
    }

    const transcript = input.text.trim();
    const revision = getTranscriptRevision(transcript);
    const previousVersionCreated = Boolean(currentTranscript && currentTranscript !== transcript);
    if (previousVersionCreated) {
      await archiveTranscript(account.platform, account.slug, videoId, currentTranscript, currentRevision!);
    }
    await writeTextFileAtomic(transcriptFile, transcript);

    const next: Video = {
      ...video,
      transcriptStatus: "completed",
      transcriptPath: toLibraryRelativePath(transcriptFile),
      transcriptRevision: revision || undefined,
      transcriptSource: input.source,
      raw: clearTranscriptError(video.raw),
      updatedAt: nowIso()
    };
    await writeJson(videoFile, next);

    return { account, video: next, transcript, revision, previousVersionCreated };
  });
}

export async function getTranscriptSnapshot(platform: Platform, accountId: string, videoId: string) {
  const transcript = await readTranscript(platform, accountId, videoId);
  return {
    transcript,
    revision: getTranscriptRevision(transcript),
    versions: await listTranscriptVersions(platform, accountId, videoId)
  };
}

export async function restoreTranscriptVersion(input: {
  platform: Platform;
  accountId: string;
  videoId: string;
  versionId: string;
  expectedRevision: string | null;
}) {
  const account = await resolveAccount(input.platform, input.accountId);
  const videoId = normalizeVideoId(input.videoId);
  const versionId = normalizeStorageSegment(input.versionId, "转写历史版本 ID");
  const target = path.join(transcriptHistoryPath(account.platform, account.slug, videoId), `${versionId}.txt`);
  const text = await readTextIfExists(target);
  if (!text) throw new Error("找不到这份转写历史版本");
  return saveTranscript({
    platform: account.platform,
    accountId: account.id,
    videoId,
    text,
    source: "manual",
    expectedRevision: input.expectedRevision
  });
}

async function listTranscriptVersions(platform: Platform, accountId: string, videoId: string): Promise<TranscriptVersion[]> {
  const account = await resolveAccount(platform, accountId);
  const normalizedVideoId = normalizeVideoId(videoId);
  const historyDir = transcriptHistoryPath(account.platform, account.slug, normalizedVideoId);
  const files = await readDirNamesIfExists(historyDir);
  const versions = await Promise.all(
    files
      .filter((file) => file.endsWith(".txt"))
      .map(async (file) => {
        const target = path.join(historyDir, file);
        const [text, stat] = await Promise.all([readTextIfExists(target), fs.stat(target)]);
        return {
          id: file.slice(0, -4),
          createdAt: stat.mtime.toISOString(),
          revision: getTranscriptRevision(text) || "",
          preview: text.replace(/\s+/g, " ").trim().slice(0, 96)
        } satisfies TranscriptVersion;
      })
  );
  return versions.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

async function archiveTranscript(platform: Platform, slug: string, videoId: string, text: string, revision: string) {
  const historyDir = transcriptHistoryPath(platform, slug, videoId);
  await fs.mkdir(historyDir, { recursive: true });
  const timestamp = nowIso().replace(/[:.]/g, "-");
  await writeTextFileAtomic(path.join(historyDir, `${timestamp}-${revision.slice(0, 12)}.txt`), text);
}

async function readTextIfExists(target: string) {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

function getTranscriptRevision(text: string) {
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex");
}

function createTranscriptConflictError() {
  const error = new Error("转写稿已被其他任务更新，请重新打开后再编辑或转写。") as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

function clearTranscriptError(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const next = { ...(raw as Record<string, unknown>) };
  delete next.transcriptError;
  return next;
}

export async function markTranscriptFailed(platform: Platform, accountId: string, videoId: string, reason: string) {
  const account = await resolveAccount(platform, accountId);
  const normalizedVideoId = normalizeVideoId(videoId);
  const lockKey = `${account.platform}:${account.slug}:${normalizedVideoId}`;
  await withVideoMutationLock(lockKey, async () => {
    const videoFile = path.join(videosPath(account.platform, account.slug), `${normalizedVideoId}.json`);
    const video = await readJson<Video>(videoFile);
    if (!video) return;
    const transcriptFile = path.join(transcriptsPath(account.platform, account.slug), `${normalizedVideoId}.txt`);
    const hasTranscript = await exists(transcriptFile);

    await writeJson(videoFile, {
      ...video,
      transcriptStatus: hasTranscript ? "completed" : "failed",
      transcriptPath: hasTranscript ? toLibraryRelativePath(transcriptFile) : undefined,
      transcriptRevision: hasTranscript ? video.transcriptRevision : undefined,
      transcriptSource: hasTranscript ? video.transcriptSource : undefined,
      raw: { ...(typeof video.raw === "object" && video.raw ? video.raw : {}), transcriptError: reason },
      updatedAt: nowIso()
    });
  });
}

export async function readTranscript(platform: Platform, accountId: string, videoId: string) {
  const account = await resolveAccount(platform, accountId);
  const normalizedVideoId = normalizeVideoId(videoId);
  const target = path.join(transcriptsPath(account.platform, account.slug), `${normalizedVideoId}.txt`);
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return "";
    throw new Error(`读取转写稿失败：${target}，${error instanceof Error ? error.message : "文件系统异常"}`);
  }
}

export async function deleteTranscript(platform: Platform, accountId: string, videoId: string) {
  const account = await resolveAccount(platform, accountId);
  const normalizedVideoId = normalizeVideoId(videoId);
  const lockKey = `${account.platform}:${account.slug}:${normalizedVideoId}`;
  return withVideoMutationLock(lockKey, async () => {
    const transcriptFile = path.join(transcriptsPath(account.platform, account.slug), `${normalizedVideoId}.txt`);
    const videoFile = path.join(videosPath(account.platform, account.slug), `${normalizedVideoId}.json`);
    const styleAnalysisFile = accountStyleSampleAnalysisPath(account.platform, account.slug, normalizedVideoId);
    const video = await readJson<Video>(videoFile);
    if (!video) throw new Error("找不到视频元数据");

    const transcript = await readTextIfExists(transcriptFile);
    const revision = getTranscriptRevision(transcript);
    if (transcript && revision) {
      await archiveTranscript(account.platform, account.slug, normalizedVideoId, transcript, revision);
    }

    await Promise.all([
      fs.rm(transcriptFile, { force: true }),
      fs.rm(styleAnalysisFile, { force: true })
    ]);
    const next: Video = {
      ...video,
      transcriptStatus: "not_started",
      transcriptPath: undefined,
      transcriptRevision: undefined,
      transcriptSource: undefined,
      updatedAt: nowIso()
    };
    await writeJson(videoFile, next);

    return { account, video: next };
  });
}

export async function deleteVideos(platform: Platform, accountId: string, videoIds: string[]) {
  const account = await resolveAccount(platform, accountId);
  const uniqueIds = [...new Set(videoIds)].filter(Boolean);
  const deleted: string[] = [];
  const targets: string[] = [];

  for (const videoId of uniqueIds) {
    const normalizedVideoId = normalizeVideoId(videoId);
    const videoFile = path.join(videosPath(account.platform, account.slug), `${normalizedVideoId}.json`);
    if (!(await exists(videoFile))) continue;
    targets.push(
      videoFile,
      path.join(transcriptsPath(account.platform, account.slug), `${normalizedVideoId}.txt`),
      transcriptHistoryPath(account.platform, account.slug, normalizedVideoId),
      accountStyleSampleAnalysisPath(account.platform, account.slug, normalizedVideoId)
    );
    deleted.push(normalizedVideoId);
  }

  if (!deleted.length) return { account, deleted };
  const backupTargets = await collectAllDraftJsonPaths();
  const lockKeys = deleted
    .map((videoId) => `${account.platform}:${account.slug}:${videoId}`)
    .sort();
  const transaction = await withVideoMutationLocks(lockKeys, () => runRecoverableLibraryMutation({
    kind: "delete-videos",
    targets,
    backupTargets,
    run: async () => {
      const draftFiles = await readDirNamesIfExists(draftsPath(account.platform, account.slug));
      await Promise.all(
        draftFiles
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const target = path.join(draftsPath(account.platform, account.slug), file);
            const draft = await readJson<Draft>(target);
            if (!draft || draft.targetType === "project") return;
            const currentVideoIds = draft.styleRef.videoIds;
            if (!currentVideoIds?.length) return;

            const nextVideoIds = currentVideoIds.filter((videoId: string) => !deleted.includes(videoId));
            if (nextVideoIds.length === currentVideoIds.length) return;

            await writeJson(target, {
              ...draft,
              styleRef: {
                ...draft.styleRef,
                videoIds: nextVideoIds.length ? nextVideoIds : undefined
              },
              updatedAt: nowIso()
            });
          })
      );
      const deletedSet = new Set(deleted);
      await updateAllDraftStyleRefs((styleRefs) => {
        let changed = false;
        const next = styleRefs.map((reference) => {
          if (
            reference.targetType !== "account"
            || reference.platform !== account.platform
            || reference.accountId !== account.id
            || !reference.videoIds?.length
          ) return reference;
          const videoIds = reference.videoIds.filter((videoId) => !deletedSet.has(videoId));
          if (videoIds.length === reference.videoIds.length) return reference;
          changed = true;
          return { ...reference, videoIds: videoIds.length ? videoIds : undefined };
        });
        return changed ? next : null;
      });
      return deleted;
    }
  }));

  return { account, deleted: transaction.result, trashOperationId: transaction.operation.id };
}

async function withVideoMutationLocks<T>(keys: string[], run: () => Promise<T>): Promise<T> {
  const [key, ...remaining] = keys;
  if (!key) return run();
  return withVideoMutationLock(key, () => withVideoMutationLocks(remaining, run));
}

export async function saveStyle(platform: Platform, accountId: string, content: string, expectedStyleHash?: string) {
  const account = await resolveAccount(platform, accountId);
  await withIdentityMutationLock(`style:${account.id}`, async () => {
    const target = stylePath(account.platform, account.slug);
    const previous = await readTextOrDefaultIfMissing(target, "");
    if (expectedStyleHash && shortHash((previous || DEFAULT_STYLE).trim()) !== expectedStyleHash) {
      throw Object.assign(new Error("风格卡在生成期间已被修改，已保留当前版本，请重新归纳。"), { statusCode: 409 });
    }
    if (previous.trim() && previous.trimEnd() !== content.trimEnd()) {
      await writeTextFileAtomic(path.join(accountPath(account.platform, account.slug), ".style-history", `${shortHash(previous)}.md`), previous);
    }
    await writeTextFileAtomic(target, content.trimEnd() + "\n");
  });
  return content.trimEnd();
}

export async function readStyle(platform: Platform, accountId: string) {
  const account = await resolveAccount(platform, accountId);
  await ensureAccountDirs(account.platform, account.slug);
  return readTextOrDefaultIfMissing(stylePath(account.platform, account.slug), DEFAULT_STYLE);
}

export async function readAccountStyleMeta(platform: Platform, accountId: string) {
  const account = await resolveAccount(platform, accountId);
  await ensureAccountDirs(account.platform, account.slug);
  return readJson<AccountStyleMeta>(styleMetaPath(account.platform, account.slug));
}

export async function saveAccountStyleMeta(platform: Platform, accountId: string, meta: Omit<AccountStyleMeta, "updatedAt">) {
  const account = await resolveAccount(platform, accountId);
  await ensureAccountDirs(account.platform, account.slug);
  const next: AccountStyleMeta = {
    ...meta,
    updatedAt: nowIso()
  };
  await writeJson(styleMetaPath(account.platform, account.slug), next);
  return next;
}

export async function readAccountStyleSampleAnalysis(platform: Platform, accountId: string, videoId: string) {
  const account = await resolveAccount(platform, accountId);
  await ensureAccountDirs(account.platform, account.slug);
  return readJson<StyleSampleAnalysisCache>(accountStyleSampleAnalysisPath(account.platform, account.slug, videoId));
}

export async function saveAccountStyleSampleAnalysis(
  platform: Platform,
  accountId: string,
  videoId: string,
  cache: StyleSampleAnalysisCache
) {
  const account = await resolveAccount(platform, accountId);
  await ensureAccountDirs(account.platform, account.slug);
  await writeJson(accountStyleSampleAnalysisPath(account.platform, account.slug, videoId), cache);
  return cache;
}

export async function saveDraft(input: DraftInput) {
  const now = nowIso();
  const id = `${now.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const title = makeDraftTitleFromContent(input.content || input.prompt || input.title, input.title);

  if (input.targetType === "project") {
    const project = await resolveProject(input.projectId);
    await ensureProjectDirs(project.slug);

    const draft: ProjectDraft = {
      ...input,
      title,
      id,
      createdAt: now,
      updatedAt: now
    };

    await writeJson(path.join(projectDraftsPath(project.slug), `${draft.id}.json`), draft);
    return draft;
  }

  const account = await resolveAccount(input.platform, input.accountId);
  await ensureAccountDirs(account.platform, account.slug);

  const draft: AccountDraft = {
    ...input,
    title,
    id,
    createdAt: now,
    updatedAt: now
  };

  await writeJson(path.join(draftsPath(account.platform, account.slug), `${draft.id}.json`), draft);
  return draft;
}

export async function resolveDraft(draftId: string) {
  await ensureLibrary();
  const normalizedDraftId = normalizeDraftId(draftId);
  const [accountDraft, projectDraft] = await Promise.all([
    findAccountDraft(normalizedDraftId),
    findProjectDraft(normalizedDraftId)
  ]);
  const result = accountDraft || projectDraft;
  if (!result) throw new Error(`找不到草稿：${normalizedDraftId}`);
  return result;
}

export async function updateDraftTitle(draftId: string, title: string) {
  const normalizedDraftId = normalizeDraftId(draftId);
  const normalizedTitle = normalizeDraftTitle(title);

  return withDraftAssetsLock(normalizedDraftId, async () => {
    const resolved = await resolveDraft(normalizedDraftId);
    const nextDraft: Draft = {
      ...resolved.draft,
      title: normalizedTitle,
      updatedAt: nowIso()
    };
    await writeJson(resolved.file, nextDraft);
    return nextDraft;
  });
}

export async function updateDraftAssets(draftId: string, assets: DraftAssets | ((current: DraftAssets) => DraftAssets)) {
  const normalizedDraftId = normalizeDraftId(draftId);
  return withDraftAssetsLock(normalizedDraftId, async () => {
    const resolved = await resolveDraft(normalizedDraftId);
    const nextAssets = typeof assets === "function" ? assets(resolved.draft.assets || {}) : assets;
    const nextDraft: Draft = {
      ...resolved.draft,
      assets: nextAssets,
      updatedAt: nowIso()
    } as Draft;
    await writeJson(resolved.file, nextDraft);
    return nextDraft;
  });
}

export async function deleteDrafts(draftIds: string[]) {
  await ensureLibrary();
  const uniqueIds = [...new Set(draftIds)].filter(Boolean).map(normalizeDraftId);
  const deleted: string[] = [];
  const targets: string[] = [];

  for (const draftId of uniqueIds) {
    const resolved = await resolveDraft(draftId).catch(() => null);
    if (!resolved) continue;
    targets.push(resolved.file, getDraftAssetBase(resolved.draft));
    deleted.push(draftId);
  }

  if (!deleted.length) return { deleted };
  const transaction = await runRecoverableLibraryMutation({
    kind: "delete-drafts",
    targets,
    run: async () => deleted
  });
  return { deleted: transaction.result, trashOperationId: transaction.operation.id };
}

export async function ensureDraftAssetDir(draftId: string, kind = "") {
  const resolved = await resolveDraft(draftId);
  const base = getDraftAssetBase(resolved.draft);
  const target = kind ? path.join(base, safeSegment(kind)) : base;
  await fs.mkdir(target, { recursive: true });
  return {
    ...resolved,
    dir: target,
    baseDir: base
  };
}

export async function getDraftAssetFile(draftId: string, assetPath: string) {
  const resolved = await ensureDraftAssetDir(draftId);
  const target = path.resolve(resolved.baseDir, assetPath);
  const relative = path.relative(resolved.baseDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("素材路径不在当前草稿目录内");
  }

  const bytes = await fs.readFileBytes(target);
  return {
    bytes,
    file: target,
    contentType: contentTypeFromExtension(target)
  };
}

export async function getAccountSummary(account: Account): Promise<AccountSummary> {
  await ensureAccountDirs(account.platform, account.slug);

  const [videoFiles, draftFiles, style] = await Promise.all([
    readDirNamesIfExists(videosPath(account.platform, account.slug)),
    readDirNamesIfExists(draftsPath(account.platform, account.slug)),
    readTextOrDefaultIfMissing(stylePath(account.platform, account.slug), DEFAULT_STYLE)
  ]);

  const videos = (
    await Promise.all(
      videoFiles
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson<Video>(path.join(videosPath(account.platform, account.slug), file)))
    )
  )
    .filter(Boolean)
    .sort((a, b) => b!.hotScore - a!.hotScore) as Video[];

  const drafts = (
    await Promise.all(
      draftFiles
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson<Draft>(path.join(draftsPath(account.platform, account.slug), file)))
    )
  )
    .filter(Boolean)
    .sort((a, b) => +new Date(b!.createdAt) - +new Date(a!.createdAt)) as Draft[];

  return {
    ...account,
    style,
    videos,
    drafts,
    videoCount: videos.length,
    transcriptCount: videos.filter(videoHasTranscript).length,
    draftCount: drafts.length
  };
}

export async function getAccountDetail(
  platform: Platform,
  accountIdOrSlug: string,
  options: DetailReadOptions = {}
): Promise<AccountDetail> {
  const account = await resolveAccount(platform, accountIdOrSlug);
  await ensureAccountDirs(account.platform, account.slug);

  const [videoFiles, draftFiles, style] = await Promise.all([
    readDirNamesIfExists(videosPath(account.platform, account.slug)),
    readDirNamesIfExists(draftsPath(account.platform, account.slug)),
    options.includeStyle
      ? readTextOrDefaultIfMissing(stylePath(account.platform, account.slug), DEFAULT_STYLE)
      : Promise.resolve<string | undefined>(undefined)
  ]);

  const videos = (
    await Promise.all(
      videoFiles
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson<Video>(path.join(videosPath(account.platform, account.slug), file)))
    )
  )
    .filter(Boolean)
    .sort((a, b) => b!.hotScore - a!.hotScore) as Video[];

  const drafts = (
    await Promise.all(
      draftFiles
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJson<Draft>(path.join(draftsPath(account.platform, account.slug), file)))
    )
  )
    .filter(Boolean)
    .sort((a, b) => +new Date(b!.createdAt) - +new Date(a!.createdAt)) as Draft[];

  return {
    ...account,
    ...(style !== undefined ? { style } : {}),
    videos: videos.map(stripVideoRaw),
    drafts,
    videoCount: videos.length,
    transcriptCount: videos.filter(videoHasTranscript).length,
    draftCount: drafts.length
  };
}

async function getAccountListItem(account: Account): Promise<AccountListItem> {
  await ensureAccountDirs(account.platform, account.slug);

  const [videoFiles, transcriptFiles, draftFiles, styleMeta, styleText, styleStat] = await Promise.all([
    readDirNamesIfExists(videosPath(account.platform, account.slug)),
    readDirNamesIfExists(transcriptsPath(account.platform, account.slug)),
    readDirNamesIfExists(draftsPath(account.platform, account.slug)),
    readJson<AccountStyleMeta>(styleMetaPath(account.platform, account.slug)),
    readTextOrDefaultIfMissing(stylePath(account.platform, account.slug), DEFAULT_STYLE),
    statIfExists(stylePath(account.platform, account.slug))
  ]);
  const videoIds = new Set(videoFiles.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)));
  const transcriptIds = new Set(transcriptFiles.filter((file) => file.endsWith(".txt")).map((file) => file.slice(0, -4)));
  const transcriptCount = [...videoIds].filter((videoId) => transcriptIds.has(videoId)).length;
  const styleStatus = isPlaceholderStyle(styleText)
    ? "not_generated"
    : styleMeta
      ? styleMeta.fallback
        ? "fallback"
        : "ready"
      : "manual";

  return {
    ...account,
    videoCount: videoIds.size,
    transcriptCount,
    missingTranscriptCount: Math.max(0, videoIds.size - transcriptCount),
    draftCount: draftFiles.filter((file) => file.endsWith(".json")).length,
    styleStatus,
    styleUpdatedAt: styleMeta?.updatedAt || (styleStatus === "manual" ? styleStat?.mtime.toISOString() : undefined)
  };
}

export async function resolveProject(projectIdOrSlug: string) {
  await ensureLibrary();
  const slug = normalizeProjectSlug(projectIdOrSlug);
  const project = await readJson<Project>(projectJsonPath(slug));
  if (!project) {
    throw new Error(`找不到项目：${slug}`);
  }
  return project;
}

export async function getProjectSummary(project: Project): Promise<ProjectSummary> {
  await ensureProjectDirs(project.slug);
  const [style, libraryAccounts, sourceMaterials] = await Promise.all([
    readTextOrDefaultIfMissing(projectStylePath(project.slug), DEFAULT_STYLE),
    getAllAccountListItems(),
    getProjectCopySources(project.sourceMaterialIds || [])
  ]);
  const sourceAccounts = libraryAccounts
    .filter((account) => project.sourceAccountIds.includes(account.id))
    .map((account) => ({
      id: account.id,
      name: account.name,
      platform: account.platform,
      videoCount: account.videoCount,
      transcriptCount: account.transcriptCount
    }));

  return {
    ...project,
    sourceMaterialIds: project.sourceMaterialIds || [],
    style,
    sourceAccounts,
    sourceMaterials,
    sourceMaterialCount: sourceMaterials.length
  };
}

async function getAllAccountListItems() {
  const accountRecords = (
    await Promise.all(
      platforms.map(async (platform) => {
        const entries = await readDirEntriesIfExists(platformPath(platform));
        return Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => readJson<Account>(accountJsonPath(platform, entry.name)))
        );
      })
    )
  ).flat().filter(Boolean) as Account[];
  const accounts = await mapWithConcurrency(accountRecords, 6, getAccountListItem);
  return accounts.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
}

async function getAllProjectListItems(accounts?: AccountListItem[]): Promise<ProjectListItem[]> {
  const entries = await readDirEntriesIfExists(projectsPath());
  const projects = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson<Project>(projectJsonPath(entry.name)))
    )
  ).filter(Boolean) as Project[];
  const libraryAccounts = accounts || await getAllAccountListItems();

  return projects
    .map((project) => {
      const sourceAccounts = libraryAccounts
        .filter((account) => project.sourceAccountIds.includes(account.id))
        .map((account) => ({
          id: account.id,
          name: account.name,
          platform: account.platform,
          videoCount: account.videoCount,
          transcriptCount: account.transcriptCount
        }));

      return {
        ...project,
        sourceMaterialIds: project.sourceMaterialIds || [],
        sourceAccounts,
        sourceMaterialCount: project.sourceMaterialIds?.length || 0
      };
    })
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
}

async function getAllAccountDrafts() {
  const draftGroups = await Promise.all(
    platforms.map(async (platform) => {
      const entries = await readDirEntriesIfExists(platformPath(platform));
      return Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .flatMap(async (entry) => {
            const files = await readDirNamesIfExists(draftsPath(platform, entry.name));
            return Promise.all(
              files
                .filter((file) => file.endsWith(".json"))
                .map((file) => readJson<AccountDraft>(path.join(draftsPath(platform, entry.name), file)))
            );
          })
      );
    })
  );

  return draftGroups.flat(2).filter(Boolean) as AccountDraft[];
}

async function getAllProjectDrafts() {
  const entries = await readDirEntriesIfExists(projectsPath());
  const drafts = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .flatMap(async (entry) => {
          const files = await readDirNamesIfExists(projectDraftsPath(entry.name));
          return Promise.all(
            files
              .filter((file) => file.endsWith(".json"))
              .map((file) => readJson<ProjectDraft>(path.join(projectDraftsPath(entry.name), file)))
          );
        })
    )
  )
    .flat()
    .filter(Boolean) as ProjectDraft[];

  return drafts.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function getDrafts() {
  await ensureLibrary();
  const [accountDrafts, projectDrafts] = await Promise.all([
    getAllAccountDrafts(),
    getAllProjectDrafts()
  ]);
  return [...accountDrafts, ...projectDrafts].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export async function getDraftSummaries() {
  return (await getDrafts()).map(toDraftSummary);
}

export function toDraftSummary(draft: Draft): DraftSummary {
  const base = {
    id: draft.id,
    title: draft.title,
    mode: draft.mode,
    version: draft.version,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };

  if (draft.targetType === "project") {
    return {
      ...base,
      targetType: "project",
      projectId: draft.projectId,
      projectName: draft.projectName
    };
  }

  return {
    ...base,
    targetType: draft.targetType,
    platform: draft.platform,
    accountId: draft.accountId,
    accountName: draft.accountName
  };
}

export async function getLibraryOverview(): Promise<LibraryOverviewResponse> {
  await ensureLibrary();
  const accounts = await getAllAccountListItems();
  const projects = await getAllProjectListItems(accounts);

  return {
    root: libraryRoot(),
    accounts,
    projects,
    copySources: [],
    engagementRecords: [],
    drafts: []
  };
}

export async function getVideo(platform: Platform, accountId: string, videoId: string) {
  const account = await resolveAccount(platform, accountId);
  const normalizedVideoId = normalizeVideoId(videoId);
  const video = await readJson<Video>(path.join(videosPath(account.platform, account.slug), `${normalizedVideoId}.json`));
  if (!video) throw new Error("找不到视频");
  return { account, video };
}

async function findAccountDraft(draftId: string) {
  for (const platform of platforms) {
    const entries = await readDirEntriesIfExists(platformPath(platform));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(draftsPath(platform, entry.name), `${draftId}.json`);
      const draft = await readJson<AccountDraft>(file);
      if (draft) return { draft: draft as Draft, file };
    }
  }
  return null;
}

async function findProjectDraft(draftId: string) {
  const entries = await readDirEntriesIfExists(projectsPath());
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projectDraftsPath(entry.name), `${draftId}.json`);
    const draft = await readJson<ProjectDraft>(file);
    if (draft) return { draft: draft as Draft, file };
  }
  return null;
}

function getDraftAssetBase(draft: Draft) {
  if (draft.targetType === "project") {
    return projectDraftAssetsPath(normalizeProjectSlug(draft.projectId), draft.id);
  }

  return draftAssetsPath(draft.platform, normalizeAccountSlug(draft.accountId), draft.id);
}

async function getProjectCopySources(sourceIds: string[]) {
  const uniqueIds = [...new Set(sourceIds)].filter(Boolean);
  const sources = await Promise.all(
    uniqueIds.map(async (sourceId) => {
      const id = normalizeCopySourceId(sourceId);
      const source = await readJson<CopySource>(copySourceJsonPath(id));
      return source ? normalizeCopySource(source) : null;
    })
  );
  return sources.filter(Boolean) as CopySource[];
}

async function removeDeletedAccountsFromProjects(accountIds: string[]) {
  const deleted = new Set(accountIds);
  const entries = await readDirEntriesIfExists(projectsPath());

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const project = await readJson<Project>(projectJsonPath(entry.name));
        const updateProject = async () => {
          if (!project) return;
          const sourceAccountIds = project.sourceAccountIds.filter((id) => !deleted.has(id));
          if (sourceAccountIds.length === project.sourceAccountIds.length) return;
          await writeJson(projectJsonPath(entry.name), {
            ...project,
            sourceAccountIds,
            updatedAt: nowIso()
          });
        };

        await Promise.all([
          updateProject(),
          updateProjectDraftRefs(entry.name, (draft) => {
            const sourceAccountIds = filterRemovedIds(draft.styleRef.sourceAccountIds, deleted);
            if (!sourceAccountIds) return null;
            return {
              ...draft.styleRef,
              sourceAccountIds: sourceAccountIds.length ? sourceAccountIds : undefined
            };
          })
        ]);
      })
  );
}

function filterRemovedIds(ids: string[] | undefined, deleted: Set<string>) {
  if (!ids?.length) return null;
  const nextIds = ids.filter((id) => !deleted.has(id));
  return nextIds.length === ids.length ? null : nextIds;
}

function removeDeletedAccountsFromStyleRefs(styleRefs: WriteStyleReference[], deleted: Set<string>) {
  let changed = false;
  const next = styleRefs.flatMap((reference): WriteStyleReference[] => {
    if (reference.targetType === "account") {
      if (!deleted.has(reference.accountId)) return [reference];
      changed = true;
      return [];
    }
    const sourceAccountIds = reference.sourceAccountIds?.filter((accountId) => !deleted.has(accountId));
    if (!reference.sourceAccountIds || sourceAccountIds?.length === reference.sourceAccountIds.length) return [reference];
    changed = true;
    return [{ ...reference, sourceAccountIds: sourceAccountIds?.length ? sourceAccountIds : undefined }];
  });
  return changed ? next : null;
}

async function updateAllDraftStyleRefs(
  update: (styleRefs: WriteStyleReference[]) => WriteStyleReference[] | null
) {
  const targets = await collectAllDraftJsonPaths();

  await Promise.all(targets.map(async (target) => {
    const draft = await readJson<Draft>(target);
    if (!draft?.styleRefs?.length) return;
    const styleRefs = update(draft.styleRefs);
    if (!styleRefs) return;
    await writeJson(target, {
      ...draft,
      styleRefs: styleRefs.length ? styleRefs : undefined,
      updatedAt: nowIso()
    });
  }));
}

async function collectAllDraftJsonPaths() {
  const targets: string[] = [];
  for (const platform of platforms) {
    const accounts = await readDirEntriesIfExists(platformPath(platform));
    for (const account of accounts) {
      if (!account.isDirectory()) continue;
      const files = await readDirNamesIfExists(draftsPath(platform, account.name));
      targets.push(...files.filter((file) => file.endsWith(".json")).map((file) => path.join(draftsPath(platform, account.name), file)));
    }
  }
  const projects = await readDirEntriesIfExists(projectsPath());
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const files = await readDirNamesIfExists(projectDraftsPath(project.name));
    targets.push(...files.filter((file) => file.endsWith(".json")).map((file) => path.join(projectDraftsPath(project.name), file)));
  }
  return targets;
}

async function collectProjectJsonPaths() {
  const projects = await readDirEntriesIfExists(projectsPath());
  return projects
    .filter((project) => project.isDirectory())
    .map((project) => projectJsonPath(project.name));
}

async function collectProjectAndDraftJsonPaths() {
  return [
    ...(await collectProjectJsonPaths()),
    ...(await collectAllDraftJsonPaths())
  ];
}

async function updateProjectDraftRefs(
  projectSlug: string,
  updateStyleRef: (draft: ProjectDraft) => ProjectDraft["styleRef"] | null
) {
  const files = await readDirNamesIfExists(projectDraftsPath(projectSlug));

  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const target = path.join(projectDraftsPath(projectSlug), file);
        const draft = await readJson<ProjectDraft>(target);
        if (!draft?.styleRef) return;
        const styleRef = updateStyleRef(draft);
        if (!styleRef) return;
        await writeJson(target, {
          ...draft,
          styleRef,
          updatedAt: nowIso()
        });
      })
  );
}

function normalizeCopySource(source: CopySource): CopySource {
  return {
    ...source,
    transcript: source.transcript || "",
    transcriptPath: toLibraryRelativePath(copySourceTranscriptPath(source.id)),
    status: source.status || "completed",
    source: source.source || "manual",
    materialAnalysis: source.materialAnalysis,
    projectIds: source.projectIds || []
  };
}

function contentTypeFromExtension(file: string) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "image/jpeg";
}

export async function getTopTranscriptSamples(platform: Platform, accountId: string, maxSamples: number | "all" = 8) {
  const account = await resolveAccount(platform, accountId);
  const summary = await getAccountSummary(account);
  const completed = summary.videos.filter(videoHasTranscript);
  const selected = maxSamples === "all" ? completed : completed.slice(0, maxSamples);

  const samples = await Promise.all(
    selected.map(async (video) => ({
      video,
      transcript: await readTranscript(platform, accountId, video.id)
    }))
  );

  return samples.filter((sample) => sample.transcript.trim());
}

function calculateHotScore(video: Video) {
  return (
    video.stats.views +
    video.stats.likes * 20 +
    video.stats.comments * 60 +
    video.stats.favorites * 80 +
    (video.stats.shares ?? 0) * 50
  );
}
