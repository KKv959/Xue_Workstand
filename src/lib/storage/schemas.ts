import path from "path";
import { z } from "zod";
import { styleEvidenceSchema, writerContextSchema } from "../writer-context";
import { imageGenerationInputSchema } from "../image-generation-types";
import { jobKinds } from "../types";
import { startJobSchema } from "../job-validation";
import { trendRadarSettingsSchema } from "../trendradar-native-types";

export const trendRadarNativeStateSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(), engineVersion: z.string().min(1),
  settings: trendRadarSettingsSchema,
  analysis: z.object({ core_trends: z.string(), sentiment_controversy: z.string(), signals: z.string(), rss_insights: z.string(), outlook_strategy: z.string() }),
  counts: z.object({ hotlist: z.number().nonnegative(), rss: z.number().nonnegative(), matched: z.number().nonnegative(), analyzed: z.number().nonnegative() }),
  warnings: z.array(z.string()), fallback: z.boolean(), fallbackReason: z.string().optional(),
  html: z.string().min(1),
  databases: z.array(z.object({ kind: z.enum(["news", "rss"]), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), data: z.string().max(64 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/) })).max(2),
});

export const STORAGE_SCHEMA_VERSION = 1;

const platformSchema = z.enum(["bilibili", "douyin"]);
const timestampSchema = z.string().min(1);
const versionedObject = z.object({
  schemaVersion: z.number().int().nonnegative().optional()
});

export const douyinHotlistWatchlistSchema = versionedObject.extend({
  schemaVersion: z.literal(1).optional(), version: z.literal(1), accountIds: z.array(z.string().min(1)),
  groups: z.array(z.object({
    id: z.string().uuid(), name: z.string().trim().min(1).max(40),
    accountIds: z.array(z.string().min(1))
  })).optional(),
  groupRevision: z.number().int().nonnegative().optional(),
  updatedAt: z.string().min(1), lastRefreshedAt: z.string().optional(),
  lastFullRefreshAttemptAt: z.string().optional(), lastFullRefreshAt: z.string().optional()
}).passthrough().superRefine((value, context) => {
  const groups = value.groups ?? [];
  if (new Set(groups.map((group) => group.id)).size !== groups.length ||
      new Set(groups.map((group) => group.name.toLocaleLowerCase())).size !== groups.length ||
      groups.some((group) => new Set(group.accountIds).size !== group.accountIds.length || group.accountIds.some((id) => !value.accountIds.includes(id)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "视频热榜分组存在重复或无效账号引用。" });
  }
});

const jobStatusSchema = z.enum(["queued", "running", "completed", "failed", "interrupted", "cancelled"]);
const jobProgressSchema = z.number().finite().min(0).max(100);
const jobTimeSchema = z.string().datetime({ offset: true });
const jobSchema = versionedObject.extend({
  id: z.string().min(1), kind: z.enum(jobKinds), status: jobStatusSchema,
  title: z.string(), message: z.string(), progress: jobProgressSchema,
  inputSummary: z.string().optional(), stage: z.string().optional(), href: z.string().optional(),
  partialText: z.string().optional(), result: z.unknown().optional(),
  resultRef: z.object({ id: z.string().optional(), href: z.string(), label: z.string() }).passthrough().optional(),
  resultCompacted: z.boolean().optional(), resultSizeBytes: z.number().int().nonnegative().optional(),
  events: z.array(z.object({ at: jobTimeSchema, status: jobStatusSchema, stage: z.string().optional(), message: z.string(), progress: jobProgressSchema }).passthrough()).optional(),
  scope: z.object({
    canvasId: z.string().optional(),
    targetType: z.enum(["account", "project", "draft", "engagement", "url", "text", "hotlist", "hotspot", "gross-margin"]).optional(),
    platform: platformSchema.optional(), accountId: z.string().optional(), projectId: z.string().optional(),
    videoId: z.string().optional(), draftId: z.string().optional(), engagementRecordId: z.string().optional(), sourceKey: z.string().optional()
  }).passthrough().optional(),
  dataRevision: z.number().int().nonnegative().optional(),
  dataChange: z.object({
    resource: z.enum(["image-generation", "library-account", "douyin-hotlist", "gross-margin", "hotspots", "drafts", "engagement"]),
    at: jobTimeSchema, accountId: z.string().optional(), videoId: z.string().optional(), recordId: z.string().optional()
  }).passthrough().optional(),
  attempt: z.number().int().nonnegative().optional(), resumedAt: jobTimeSchema.optional(), error: z.string().optional(),
  createdAt: jobTimeSchema, updatedAt: jobTimeSchema, completedAt: jobTimeSchema.optional()
}).passthrough();

const accountSchema = versionedObject.extend({
  id: z.string().min(1),
  slug: z.string().min(1),
  platform: platformSchema,
  name: z.string().min(1),
  uid: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).passthrough();

const videoSchema = versionedObject.extend({
  id: z.string().min(1),
  platform: platformSchema,
  accountId: z.string().min(1),
  title: z.string(),
  url: z.string(),
  stats: z.object({
    views: z.number().finite(),
    likes: z.number().finite(),
    comments: z.number().finite(),
    favorites: z.number().finite(),
    shares: z.number().finite().optional()
  }).passthrough(),
  hotScore: z.number().finite(),
  relativeViewRate: z.number().finite(),
  transcriptStatus: z.enum(["not_started", "pending", "transcribing", "failed", "completed"]),
  updatedAt: timestampSchema
}).passthrough();

const projectSchema = versionedObject.extend({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  sourceAccountIds: z.array(z.string()),
  sourceMaterialIds: z.array(z.string()).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).passthrough();

const draftStyleReferenceSchema = z.discriminatedUnion("targetType", [
  z.object({
    targetType: z.literal("account"),
    platform: platformSchema,
    accountId: z.string().min(1),
    accountName: z.string().min(1),
    videoIds: z.array(z.string()).optional()
  }),
  z.object({
    targetType: z.literal("project"),
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    sourceAccountIds: z.array(z.string()).optional(),
    sourceMaterialIds: z.array(z.string()).optional()
  })
]);

const draftBaseSchema = versionedObject.extend({
  version: z.object({ batchId: z.string().min(1).max(100).optional() }).passthrough().optional(),
  id: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(["topic", "rewrite"]),
  prompt: z.string(),
  originalSourceInput: z.string().optional(),
  content: z.string(),
  styleRef: z.record(z.unknown()),
  styleRefs: z.array(draftStyleReferenceSchema).min(1).optional(),
  writerContext: writerContextSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

const accountDraftSchema = draftBaseSchema.extend({
  targetType: z.literal("account").optional(),
  platform: platformSchema,
  accountId: z.string().min(1),
  accountName: z.string().min(1)
}).passthrough();

const projectDraftSchema = draftBaseSchema.extend({
  targetType: z.literal("project"),
  projectId: z.string().min(1),
  projectName: z.string().min(1)
}).passthrough();

const copySourceSchema = versionedObject.extend({
  id: z.string().min(1),
  title: z.string().min(1),
  platform: z.union([platformSchema, z.literal("unknown")]),
  url: z.string(),
  transcript: z.string(),
  transcriptPath: z.string(),
  source: z.enum(["platform_subtitle", "volcengine", "metadata", "manual"]),
  status: z.enum(["completed", "failed"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).passthrough();

const engagementRecordSchema = versionedObject.extend({
  id: z.string().min(1),
  sourceType: z.enum(["draft", "text", "url"]),
  title: z.string().min(1),
  platform: z.union([platformSchema, z.literal("unknown")]),
  sourceText: z.string(),
  sourceDurationSec: z.number().finite().nonnegative().optional(),
  sourceSegments: z.array(z.object({ startSec: z.number().finite().nonnegative(), endSec: z.number().finite().nonnegative(), text: z.string() })).optional(),
  options: z.object({
    includeComments: z.boolean(),
    commentCount: z.number().int().nonnegative(),
    includeDanmaku: z.boolean(),
    danmakuCount: z.number().int().nonnegative()
  }).passthrough(),
  fallback: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).passthrough();

const supportDocumentCacheSchema = versionedObject.extend({
  cacheKey: z.string().min(1),
  url: z.string().min(1),
  provider: z.enum(["feishu", "lingxi", "wecom", "tencent-docs", "web"]),
  title: z.string().optional(),
  content: z.string().min(1),
  fetchedAt: timestampSchema
}).passthrough();

const styleAnalysisSchema = versionedObject.extend({
  version: z.literal(1), cacheKey: z.string().min(1),
  kind: z.enum(["account-video", "copy-source"]), sourceId: z.string().min(1),
  title: z.string(), inputChars: z.number().nonnegative(), analysis: z.string(),
  evidence: styleEvidenceSchema.optional(), usedModel: z.string(),
  reasoningEffort: z.string(), generatedAt: timestampSchema
}).passthrough();

const styleMetaSchema = versionedObject.extend({
  sampleHash: z.string().min(1), sampleCount: z.number().int().nonnegative(),
  usedModel: z.string(), updatedAt: timestampSchema,
  sampleFingerprints: z.array(z.object({ videoId: z.string(), hash: z.string() })).optional(),
  sampleVideoIds: z.array(z.string()).optional()
}).passthrough();

const grossMarginAmountSchema = z.number().finite().nonnegative();
const grossMarginServiceSchema = z.enum(["play", "like", "douPlus", "mustFire", "coin", "comment", "share", "favorite", "danmaku", "blueLink"]);
const grossMarginStatsSchema = z.record(grossMarginServiceSchema, grossMarginAmountSchema);
const grossMarginAccountSchema = z.object({
  platform: platformSchema, name: z.string().min(1), defaultPrice: grossMarginAmountSchema,
  secondaryPrice: grossMarginAmountSchema.optional(), priceLabel: z.string().optional(),
  secondaryPriceLabel: z.string().optional(), douyinId: z.string().optional(),
  cooperationCode: z.string().optional(), bilibiliUid: z.string().optional(), homepage: z.string().optional()
}).passthrough();
const grossMarginAccountsSchema = z.array(grossMarginAccountSchema);
const grossMarginTableSchema = versionedObject.extend({
  platform: platformSchema, updatedAt: timestampSchema,
  items: z.array(z.object({
    id: z.string().min(1), service: grossMarginServiceSchema, name: z.string(),
    unitPrice: grossMarginAmountSchema, quantityUnit: z.enum(["万", "千", "个", "元"]),
    minimumQuantity: grossMarginAmountSchema.nullable().optional(),
    active: z.boolean().optional(), note: z.string().optional(), updatedAt: timestampSchema.optional()
  }).passthrough())
}).passthrough();
const grossMarginMonitorSchema = versionedObject.extend({
  id: z.string().min(1), revision: z.number().int().nonnegative().optional(), platform: platformSchema,
  accountName: z.string(), videoUrl: z.string(), videoKey: z.string(), sourceText: z.string(),
  maintenanceProject: z.object({ orderId: z.string().trim().min(1), name: z.string().trim().min(1) }).optional(),
  targetStats: grossMarginStatsSchema, currentStats: grossMarginStatsSchema.optional(),
  previousStats: grossMarginStatsSchema.optional(),
  playSamples: z.array(z.object({ value: grossMarginAmountSchema, capturedAt: timestampSchema, source: z.enum(["manual", "refresh"]) })).optional(),
  status: z.enum(["pending", "completed", "partial", "failed"]), warnings: z.array(z.string()),
  createdAt: timestampSchema, updatedAt: timestampSchema
}).passthrough();

export type StoredRecordKind =
  | "gross-margin-table"
  | "gross-margin-template"
  | "gross-margin-monitor"
  | "gross-margin-accounts"
  | "gross-margin-account-cache"
  | "gross-margin-project-cache"
  | "job"
  | "job-payload"
  | "image-generation"
  | "image-file"
  | "style-analysis"
  | "style-meta"
  | "account"
  | "video"
  | "project"
  | "draft"
  | "copy-source"
  | "engagement"
  | "support-document-cache";

const schemas: Record<StoredRecordKind, z.ZodTypeAny> = {
  "gross-margin-project-cache": versionedObject.extend({
    month: z.string().regex(/^\d{4}-\d{2}$/), fetchedAt: timestampSchema, stale: z.boolean(),
    orders: z.array(z.object({
      id: z.string().min(1), month: z.string().regex(/^\d{4}-\d{2}$/), platform: z.enum(["douyin", "bilibili"]),
      accountName: z.string().min(1), projectName: z.string().min(1),
      orderAmount: grossMarginAmountSchema.nullable(), rebateAmount: grossMarginAmountSchema.nullable(), finalPrice: grossMarginAmountSchema.nullable(),
      videoUrl: z.string(), date: z.string(), warning: z.string().optional()
    }))
  }),
  "gross-margin-table": grossMarginTableSchema,
  "gross-margin-template": versionedObject.extend({ platform: platformSchema, content: z.string(), updatedAt: timestampSchema }).passthrough(),
  "gross-margin-monitor": grossMarginMonitorSchema,
  // 只读兼容旧的账号数组；新对象仍使用统一版本检查。
  "gross-margin-accounts": z.union([grossMarginAccountsSchema, versionedObject.extend({ accounts: grossMarginAccountsSchema }).transform(value => value.accounts)]),
  "gross-margin-account-cache": versionedObject.extend({ source: z.enum(["local", "wecom"]), accounts: grossMarginAccountsSchema, fetchedAt: timestampSchema.optional() }).passthrough(),
  job: jobSchema,
  "job-payload": versionedObject.extend({ version: z.literal(1), input: startJobSchema }).passthrough(),
  "image-generation": imageGenerationInputSchema.extend({
    source: z.enum(["subscription", "relay"]).optional(),
    schemaVersion: z.literal(STORAGE_SCHEMA_VERSION), id: z.string().min(1), model: z.string().min(1),
    createdAt: timestampSchema, updatedAt: timestampSchema, deletedAt: timestampSchema.optional(),
    images: z.array(z.object({ id: z.string().uuid(), name: z.string(), format: z.enum(["png", "jpeg", "webp"]), createdAt: timestampSchema })).max(4)
  }),
  "image-file": z.object({ schemaVersion: z.literal(STORAGE_SCHEMA_VERSION), id: z.string().uuid(), name: z.string(), format: z.enum(["png", "jpeg", "webp"]), createdAt: timestampSchema }),
  "style-analysis": styleAnalysisSchema,
  "style-meta": styleMetaSchema,
  account: accountSchema,
  video: videoSchema,
  project: projectSchema,
  draft: z.union([accountDraftSchema, projectDraftSchema]),
  "copy-source": copySourceSchema,
  engagement: engagementRecordSchema,
  "support-document-cache": supportDocumentCacheSchema
};

export function storedRecordKind(target: string, root: string): StoredRecordKind | null {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  const file = segments.at(-1) || "";
  if (segments[0] === "gross-margin") {
    if (segments.length === 3 && segments[1] === "project-orders" && file.endsWith(".json")) return "gross-margin-project-cache";
    if (segments.length === 3 && segments[1] === "monitor-records" && file.endsWith(".json")) return "gross-margin-monitor";
    if (segments.length === 2) {
      if (file === "accounts.json") return "gross-margin-accounts";
      if (file === "accounts.wecom-cache.json") return "gross-margin-account-cache";
      if (/^(douyin|bilibili)\.template\.json$/.test(file)) return "gross-margin-template";
      if (/^(douyin|bilibili)\.json$/.test(file)) return "gross-margin-table";
    }
  }
  if (segments[0] === "images" && segments.length === 3 && file.endsWith(".json")) {
    if (segments[1] === "records") return "image-generation";
    if (segments[1] === "files") return "image-file";
  }

  if (["bilibili", "douyin", "projects"].includes(segments[0]) && segments.length === 3 && file === "style.meta.json") return "style-meta";

  if (((segments[0] === "bilibili" || segments[0] === "douyin") && segments.length === 4 && segments[2] === "style-samples" && file.endsWith(".json")) ||
    (segments[0] === "copy-tools" && segments[1] === "sources" && file.endsWith(".style-analysis.json"))) return "style-analysis";

  if ((segments[0] === "bilibili" || segments[0] === "douyin") && segments.length === 3 && file === "account.json") {
    return "account";
  }
  if ((segments[0] === "bilibili" || segments[0] === "douyin") && segments.length === 4 && segments[2] === "videos" && file.endsWith(".json")) {
    return "video";
  }
  if ((segments[0] === "bilibili" || segments[0] === "douyin") && segments.length === 4 && segments[2] === "drafts" && file.endsWith(".json")) {
    return "draft";
  }
  if (segments[0] === "projects" && segments.length === 3 && file === "project.json") {
    return "project";
  }
  if (segments[0] === "projects" && segments.length === 4 && segments[2] === "drafts" && file.endsWith(".json")) {
    return "draft";
  }
  if (segments[0] === "copy-tools" && segments[1] === "sources" && file.endsWith(".json") && !file.endsWith(".style-analysis.json")) {
    return "copy-source";
  }
  if (segments[0] === "engagement" && segments.length === 2 && file.endsWith(".json")) {
    return "engagement";
  }
  if (segments[0] === ".cache" && segments[1] === "support-documents" && segments.length === 3 && file.endsWith(".json")) {
    return "support-document-cache";
  }
  return null;
}

export function parseStoredRecord<T>(target: string, value: unknown, kind: StoredRecordKind): T {
  if (!value || typeof value !== "object" || (Array.isArray(value) && kind !== "gross-margin-accounts")) {
    throw new Error(`存储记录结构无效：${target} 必须是 JSON 对象。`);
  }

  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version !== undefined && (!Number.isInteger(version) || Number(version) < 0)) {
    throw new Error(`存储记录版本无效：${target} 的 schemaVersion 必须是非负整数。`);
  }
  if (typeof version === "number" && version > STORAGE_SCHEMA_VERSION) {
    throw new Error(`存储记录版本过新：${target} 使用版本 ${version}，当前仅支持到 ${STORAGE_SCHEMA_VERSION}。`);
  }

  const parsed = schemas[kind].safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "根节点"}: ${issue.message}`)
      .join("；");
    throw new Error(`存储记录结构无效：${target}（${kind}）。${detail}`);
  }
  return parsed.data as T;
}

export function versionStoredRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    schemaVersion: STORAGE_SCHEMA_VERSION
  };
}


export const aiPolicyValueSchema = z.object({
  model: z.string().trim().max(120, "模型名称不能超过 120 字符").regex(/^[A-Za-z0-9._:/-]*$/, "模型名称只能包含字母、数字及 . _ : / -"),
  effort: z.enum(["default", "none", "low", "medium", "high", "xhigh"], { errorMap: () => ({ message: "推理等级不受支持" }) }),
  source: z.enum(["auto", "subscription", "relay"]).optional()
}).strict();
export const aiSettingsSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().nullable(), overrides: z.record(aiPolicyValueSchema)
}).strict();

const radarGradeSchema = z.enum(["吊爆了", "有点东西", "能做", "还行", "先看看"]);
const radarRatingSchema = z.enum(["吊爆了", "还行", "不行"]);
const radarBoardSchema = z.enum(["entertainment", "game", "esports", "ai"]);
const radarMonitorSchema = z.enum(["operations", "official", "esports", "breakout"]);
const strings = z.array(z.string());
const radarSignalSchema = z.object({
  inputKind: z.enum(["hotlist", "rss", "video"]).optional(), observedAt: z.string().optional(),
  metrics: z.object({ rank: z.number().optional(), likes: z.number().optional(), comments: z.number().optional(), views: z.number().optional() }).optional(),
  id: z.string(), sourceId: z.string(), sourceName: z.string(), sourceType: z.enum(["official", "news", "video", "community", "social"]),
  board: radarBoardSchema, title: z.string(), url: z.string().optional(), game: z.string(), category: z.string(), capturedAt: z.string(), publishedAt: z.string().optional(), heat: z.number(), trend: z.string(), tags: strings, summary: z.string().optional()
});
const radarEventSchema = z.object({
  eventFingerprint: z.string().optional(), updatedAt: z.string().optional(), development: z.string().optional(),
  timeline: z.array(z.object({ signalId: z.string(), title: z.string(), source: z.string(), url: z.string(), publishedAt: z.string().optional() })).max(30).optional(),
  id: z.string(), board: radarBoardSchema, monitorType: radarMonitorSchema, monitorLabel: z.string(), triggerMode: z.string(), thresholdHint: z.string(), actionWindow: z.string(), priorityLabel: z.string(), scopeMatches: strings,
  title: z.string(), game: z.string(), category: z.string(), status: z.enum(["ready", "watch", "risk"]), score: z.number(), freshness: z.string(), sources: z.number(), summary: z.string(), whyNow: z.string(), playerFocus: strings, angles: strings, evidence: strings, research: strings, risks: strings, accounts: strings, signalIds: strings, sourceIds: strings.optional(),
  gradeLabel: radarGradeSchema.optional(), userRating: radarRatingSchema.optional(), entryPoint: z.string().optional(), commentDirection: z.string().optional(), publishedAt: z.string().optional(), retainedUntil: z.string().optional(),
  displayInfo: z.object({ kind: radarMonitorSchema, subject: z.string(), headline: z.string(), statusLine: z.string(), timeLabel: z.string(), sourceLine: z.string(), facts: strings, primaryAction: z.string() })
});
const radarCounts = { sourceCount: z.number(), completedSourceCount: z.number(), failedSourceCount: z.number(), signalCount: z.number(), hotspotCount: z.number(), readyCount: z.number(), averageScore: z.number() };
export const hotspotSnapshotSchema = z.object({
  // 兼容现有规则版快照，后续写入统一添加版本号，不批量改写旧资产。
  schemaVersion: z.literal(1).optional(), generatedAt: z.string(),
  scouts: z.array(z.object({ id: z.string(), board: radarBoardSchema, name: z.string(), scope: z.string(), cadence: z.string(), cacheStatus: z.enum(["fresh", "validated", "network", "stale"]).optional(), sources: strings, status: z.enum(["running", "queued", "paused", "failed"]), coverage: z.number(), itemCount: z.number(), lastCheckedAt: z.string().optional(), error: z.string().optional() })),
  signals: z.array(radarSignalSchema), hotspots: z.array(radarEventSchema),
  summary: z.object({ ...radarCounts, generatedAt: z.string(), boardStats: z.array(z.object({ ...radarCounts, board: radarBoardSchema, topScore: z.number() })) }),
  refresh: z.object({ requested: z.number(), completed: z.number(), failed: z.number(), sources: z.array(z.object({ id: z.string(), board: radarBoardSchema, name: z.string(), status: z.enum(["completed", "failed"]), itemCount: z.number(), error: z.string().optional() })) }),
  analysis: z.object({ method: z.literal("ai-two-pass"), pipeline: z.literal("unified-events").optional(), eventCount: z.number().optional(), candidateCount: z.number(), coarseCount: z.number(), analyzedCount: z.number(), coverage: z.number(), reusedItemCount: z.number().optional(), fallback: z.boolean(), fallbackReason: z.string().optional() }).optional(),
  dailyReport: z.object({ headline: z.string(), overview: z.string(), signals: strings, communityMood: z.string(), tomorrowWatch: strings }).optional()
});
export const hotspotFeedbackSchema = z.object({
  schemaVersion: z.literal(1),
  ratings: z.array(z.object({ hotspotId: z.string(), title: z.string(), summary: z.string(), rating: radarRatingSchema, updatedAt: z.string() })).max(1000),
  history: z.array(z.object({ hotspotId: z.string(), rating: radarRatingSchema, updatedAt: z.string() })).max(1000)
});

export const hotspotCollectionSchema = z.object({
  pipeline: z.literal("unified-events").optional(),
  schemaVersion: z.literal(1), generatedAt: z.string(),
  signals: z.array(radarSignalSchema), scouts: hotspotSnapshotSchema.shape.scouts,
  status: z.enum(["collected", "analyzing", "completed", "failed", "cancelled"]),
  analysis: hotspotSnapshotSchema.shape.analysis,
  completedSignalIds: strings.optional(),
  error: z.string().optional(), partialHotspots: z.array(radarEventSchema),
  analyzedCount: z.number().nonnegative(), candidateCount: z.number().nonnegative()
});

export const hotspotCheckpointSchema = z.object({
  schemaVersion: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), result: z.unknown(), fallbackReason: z.string().optional()
});



const engagementResearchCount = z.number().int().nonnegative();
export const commentCollectionAttemptSchema = z.object({
  videoId: z.string().min(1), requestedCount: engagementResearchCount, collectedCount: engagementResearchCount,
  acceptedCount: engagementResearchCount.optional(), elapsedMs: z.number().nonnegative(),
  stopReason: z.enum(["target_reached", "exhausted", "failed", "cancelled"]), error: z.string().optional(),
  pages: z.array(z.object({
    cursor: engagementResearchCount, nextCursor: engagementResearchCount,
    returnedCount: engagementResearchCount, addedCount: engagementResearchCount, hasMore: z.boolean()
  }))
});
const engagementSampleSchema = z.object({
  platform: platformSchema, query: z.string(), videoId: z.string(), videoTitle: z.string(),
  videoMetric: z.number(), videoPublishedAt: z.string().optional(), text: z.string(),
  likes: z.number(), replies: z.number(), collectedAt: z.string(), sourceKind: z.enum(["related_video", "library"]).optional()
});
export const engagementResearchCacheSchema = z.object({
  schemaVersion: z.literal(1), engineVersion: z.string().min(1), cachedAt: z.string().datetime(),
  research: z.object({
    capturedSamples: z.array(engagementSampleSchema).optional(),
    referenceSamples: z.array(engagementSampleSchema).optional(),
    referenceTextChars: engagementResearchCount.optional(),
    collectionCoverage: z.object({ target: engagementResearchCount, uniqueCount: engagementResearchCount,
      attemptedVideoCount: engagementResearchCount, targetReached: z.boolean() }).optional(),
    collectionSources: z.array(z.object({
      collectionAttempts: z.array(commentCollectionAttemptSchema).optional(),
      source: platformSchema, query: z.string(), elapsedMs: z.number().nonnegative().optional(),
      videos: z.array(z.object({ id: z.string(), title: z.string(), query: z.string().optional(), commentCount: z.number().int().nonnegative().optional(), metric: z.number(), publishedAt: z.string().optional() })),
      comments: z.array(engagementSampleSchema), replyCommentCount: engagementResearchCount, error: z.string().optional()
    })).optional(),
    usedQueries: strings.min(1).max(2), searchAnchors: strings, searchEventTerms: strings, failedQueries: strings,
    searchPlan: z.array(z.object({ query: z.string(), videoType: z.string(), discussion: z.string() })).optional(),
    capturedCommentCount: engagementResearchCount, relatedVideoCount: engagementResearchCount,
    relatedCommentCount: engagementResearchCount, freshCommentCount: engagementResearchCount,
    targetPlatformCommentCount: engagementResearchCount, matchedLibraryCommentCount: engagementResearchCount,
    replySampleCount: engagementResearchCount, longCommentCount: engagementResearchCount,
    lengthBuckets: z.object({ short: engagementResearchCount, medium: engagementResearchCount, long: engagementResearchCount }),
    intentBuckets: z.record(engagementResearchCount),
    sourceStats: z.array(z.object({
      source: platformSchema, status: z.enum(["completed", "partial", "failed"]),
      videoCount: engagementResearchCount, commentCount: engagementResearchCount, error: z.string().optional()
    })),
    quarantinedVideoCount: engagementResearchCount, quarantinedCommentCount: engagementResearchCount,
    quarantinedSources: z.array(z.object({
      platform: platformSchema, videoId: z.string(), videoTitle: z.string(),
      commentCount: engagementResearchCount, detection: z.literal("heuristic"), reasons: strings
    })),
    quarantineClassifierStatus: z.literal("not_needed"),
    hotComments: strings.min(1), reusableComments: strings.length(0), sampleLibraryCount: z.literal(0),
    themes: strings, phrases: strings, questions: strings, objections: strings, recentTopics: strings,
    legacyTopics: strings, playerLifeAngles: strings, platformAngles: strings, replyAngles: strings,
    longCommentPatterns: strings, chatterAngles: strings, summaryError: z.string().optional()
  }).passthrough()
});

export const writerResearchCacheSchema = z.object({
  schemaVersion: z.literal(1), cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
  fetchedAt: z.number().int().nonnegative(), content: z.string().trim().min(1)
});

export const engagementModelCallSchema = z.object({
  schemaVersion: z.literal(1), scope: z.string(), policy: z.string().optional(),
  startedAt: z.string().datetime(), completedAt: z.string().datetime().optional(), elapsedMs: z.number().nonnegative().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  configured: z.object({ model: z.string(), effort: z.string() }).optional(),
  actual: z.object({ model: z.string(), wireApi: z.string().optional(), reasoningEffort: z.string().optional(), backend: z.enum(["pi", "legacy"]).optional(), fallback: z.boolean().optional(), fallbackReason: z.string().optional() }).optional(),
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })),
  retries: z.array(z.object({ at: z.string().datetime(), message: z.string() })),
  responseText: z.string().optional(), error: z.string().optional()
});

export const danmakuBatchCheckpointSchema = z.object({
  schemaVersion: z.literal(1), signature: z.string().min(1),
  index: z.number().int().nonnegative(), texts: z.array(z.string()).min(1).max(100),
  model: z.string(), attempts: z.number().int().positive().max(2), fallbackReason: z.string().optional()
});

export const commentPipelineCheckpointSchema = z.object({
  schemaVersion: z.literal(1), signature: z.string().min(1), referenceSignature: z.string().min(1),
  updatedAt: z.string().datetime(), research: engagementResearchCacheSchema.shape.research,
  rounds: z.array(z.object({ requestedCount: z.number().int().positive(), batchIds: z.array(z.number().int().nonnegative()) })),
  batches: z.array(z.object({
    index: z.number().int().nonnegative(), requestedCount: z.number().int().positive().max(200),
    candidates: strings.max(200).optional(), model: z.string(), attempts: z.number().int().nonnegative(),
    reviewCandidates: strings.max(200).optional(),
    error: z.string().optional(),
    review: z.array(z.object({ text: z.string(), keep: z.boolean(), reason: z.string().optional() })).max(200).optional()
  })),
  roundLimit: z.number().int().positive().optional(),
  exhausted: z.boolean()
}).superRefine((state, context) => {
  const ids = state.rounds.flatMap((round) => round.batchIds);
  if (ids.length !== state.batches.length || ids.some((id, index) => id !== index)) {
    context.addIssue({ code: "custom", message: "评论检查点批次顺序不完整", path: ["rounds"] });
  }
  for (const round of state.rounds) {
    if (round.batchIds.reduce((sum, id) => sum + (state.batches[id]?.requestedCount || 0), 0) !== round.requestedCount) {
      context.addIssue({ code: "custom", message: "评论检查点轮次数量不匹配", path: ["rounds"] });
    }
  }
  state.batches.forEach((batch, index) => {
    const savedTexts = batch.review?.map((row) => row.text).sort();
    const candidateTexts = batch.reviewCandidates?.slice().sort();
    if (batch.index !== index || (batch.reviewCandidates && !batch.candidates)
      || (batch.review && (!batch.reviewCandidates || batch.review.length !== batch.reviewCandidates.length
        || savedTexts?.some((text, textIndex) => candidateTexts?.[textIndex] !== text)))) {
      context.addIssue({ code: "custom", message: "评论检查点保存结果不匹配", path: ["batches", index] });
    }
  });
});
