import type { RadarAnalysis, RadarDailyReport, RadarGrade, RadarRating } from "./hotspot-radar/types";
import type { ImagePromptAssistInput } from "./image-prompt-assist-types";
import type { ImageGenerationInput } from "./image-generation-types";
export const platforms = ["bilibili", "douyin"] as const;

export type Platform = (typeof platforms)[number];

export type RemoteServiceHealth = {
  status: "ok" | "unconfigured" | "unavailable";
  message?: string;
};

export type ServiceMode = "development" | "production";
export type ServiceModeStatus = {
  mode: ServiceMode;
  available: boolean;
  reason?: string;
  switching?: boolean;
  error?: string;
};

export type RemoteStatusResponse = {
  app: {
    status: "ok" | "degraded";
    version: string;
    buildId: string;
    startedAt: string;
    appMode: "workspace" | "gross-margin";
  };
  services: Record<
    "storage" | "opencli" | "browserBridge" | "ffmpeg" | "chat" | "image",
    RemoteServiceHealth
  >;
  capabilities: {
    webResearch: {
      available: boolean;
      wireApi: "responses" | "chat_completions" | "auto";
      model?: string;
      source?: "dedicated" | "chat";
      reason?: string;
    };
  };
  checkedAt: string;
};

export const collectOrders = ["views", "likes", "favorites", "comments", "pubdate"] as const;

export type CollectOrder = (typeof collectOrders)[number];

export type TranscriptStatus =
  | "not_started"
  | "pending"
  | "transcribing"
  | "failed"
  | "completed";

export type Account = {
  id: string;
  slug: string;
  platform: Platform;
  name: string;
  uid: string;
  sourceUrl?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastCollectedAt?: string;
};

export type VideoStats = {
  views: number;
  likes: number;
  comments: number;
  favorites: number;
  shares?: number;
};

export type VideoHotlistTrend = {
  previousHotScore: number;
  currentHotScore: number;
  heatDelta: number;
  intervalHours: number;
  previousUpdatedAt: string;
  updatedAt: string;
};

export type VideoHotlistSurgeState = {
  heatDelta: number;
  heatPerHour: number;
  intervalHours: number;
  detectedAt: string;
  expiresAt: string;
};

export type Video = {
  id: string;
  platform: Platform;
  accountId: string;
  title: string;
  url: string;
  coverUrl?: string;
  publishedAt?: string;
  duration?: string | number;
  stats: VideoStats;
  hotScore: number;
  hotScoreVersion?: number;
  relativeViewRate: number;
  transcriptStatus: TranscriptStatus;
  transcriptPath?: string;
  transcriptRevision?: string;
  transcriptSource?: "platform_subtitle" | "siliconflow" | "volcengine" | "manual";
  statsHydration?: {
    status: "unknown" | "partial" | "complete" | "failed";
    source?: "collect" | "opencli";
    checkedAt?: string;
    missingFields?: Array<keyof VideoStats>;
    error?: string;
  };
  downloadUrl?: string;
  topComments?: string[];
  danmakuSamples?: string[];
  raw?: unknown;
  hotlistTrend?: VideoHotlistTrend;
  hotlistSurge?: VideoHotlistSurgeState;
  updatedAt: string;
};

export type DraftCommentAsset = {
  id: string;
  platform: Platform | "unknown";
  text: string;
  origin?: "ai_generated" | "reused_hot_comment";
};

export type DraftDanmakuAsset = {
  id: string;
  timeSec?: number;
  text: string;
};

export const engagementGenerationModes = ["quick", "reference", "research"] as const;

export type EngagementGenerationMode = (typeof engagementGenerationModes)[number];

export type EngagementResearchReview = {
  status: "completed" | "partial";
  candidateCount: number;
  reviewedCount: number;
  rejectedCount: number;
  unreviewedCount: number;
  decisions: Array<{
    platform: Platform; videoId: string; videoTitle: string; query: string; text: string;
    keep: boolean; natural: boolean; contextComplete: boolean; reason: string; articleEvidence: string;
  }>;
};

export type EngagementGenerationTimings = {
  sourceMs: number;
  briefMs: number;
  researchMs: number;
  generationMs: number;
  totalMs: number;
  cacheHits: Array<"source" | "brief" | "research">;
};

export type DraftCoverReference = {
  id: string;
  source: "account" | "upload";
  label: string;
  path?: string;
  url?: string;
  accountId?: string;
  accountName?: string;
  videoId?: string;
  videoTitle?: string;
  createdAt: string;
};

export type DraftCoverImage = {
  id: string;
  path: string;
  prompt: string;
  referenceIds: string[];
  model: string;
  size: string;
  quality: string;
  format: "jpeg" | "png" | "webp";
  createdAt: string;
};

export type DraftAssets = {
  comments?: {
    generatedAt: string;
    requestedCount: number;
    actualCount?: number;
    partial?: boolean;
    generationMode?: EngagementGenerationMode;
    engineVersion?: string;
    timings?: EngagementGenerationTimings;
    usedModel: string;
    fallback: boolean;
    fallbackReason?: string;
    diagnostics?: {
      sourceBrief?: {
        summary: string;
        topic: string;
        subjects: string[];
        keyFacts: string[];
        audiencePersonas?: string[];
        viewerScenes: string[];
        discussionAngles: string[];
        skepticalAngles: string[];
        anchorTerms: string[];
      };
      entityGuard?: {
        allowedModels: string[];
        blockedModels?: string[];
        correctedTerms: {
          from: string;
          to: string;
          stage: "brief" | "relatedResearch" | "comment";
        }[];
      };
      relatedResearch?: {
        review?: EngagementResearchReview;
        voiceReferences?: string[];
        capturedCommentCount?: number;
        searchPlan?: Array<{ query: string; videoType: string; discussion: string }>;
        usedQueries: string[];
        searchAnchors?: string[];
        searchEventTerms?: string[];
        failedQueries: string[];
        relatedVideoCount: number;
        relatedCommentCount: number;
        freshCommentCount?: number;
        targetPlatformCommentCount?: number;
        sourceCommentCount?: number;
        sourceVideoId?: string;
        sourceTitle?: string;
        originalFetchError?: string;
        matchedLibraryCommentCount?: number;
        forumSourceCount?: number;
        forumCommentCount?: number;
        replySampleCount?: number;
        sourceStats?: Array<{
          source: "bilibili" | "douyin" | "forum";
          status: "completed" | "partial" | "failed";
          videoCount: number;
          commentCount: number;
          error?: string;
        }>;
        quarantinedVideoCount?: number;
        quarantinedCommentCount?: number;
        quarantinedSources?: Array<{
          platform: Platform;
          videoId: string;
          videoTitle: string;
          commentCount: number;
          detection: "heuristic" | "model";
          reasons: string[];
        }>;
        quarantineClassifierStatus?: "completed" | "fallback" | "not_needed";
        quarantineClassifierError?: string;
        hotComments?: string[];
        reusableComments?: string[];
        sampleLibraryCount?: number;
        longCommentCount?: number;
        lengthBuckets?: {
          short: number;
          medium: number;
          long: number;
        };
        intentBuckets?: {
          reaction: number;
          question: number;
          price: number;
          comparison: number;
          skeptical: number;
          experience: number;
          follow: number;
          chatter: number;
        };
        themes: string[];
        phrases: string[];
        questions: string[];
        objections: string[];
        recentTopics?: string[];
        legacyTopics?: string[];
        playerLifeAngles?: string[];
        platformAngles?: string[];
        replyAngles?: string[];
        longCommentPatterns?: string[];
        chatterAngles?: string[];
        summaryError?: string;
      };
      research?: {
        relatedCommentCount: number;
        relatedCommentUsed: number;
        relatedVideoCount: number;
        relatedLongCommentCount?: number;
        relatedIntentBuckets?: {
          reaction: number;
          question: number;
          price: number;
          comparison: number;
          skeptical: number;
          experience: number;
          follow: number;
          chatter: number;
        };
        usedQueries: string[];
        failedQueries: string[];
        skippedRelatedSearch: boolean;
        quarantinedVideoCount?: number;
        quarantinedCommentCount?: number;
        sourceCommentCount?: number;
        sourceAwemeId?: string;
        sourceTitle?: string;
        originalFetchError?: string;
      }[];
      generation?: {
        mode?: "keyword_local" | "model_batch";
        requestedCount: number;
        batchSize: number;
        batchCount: number;
        parsedCount: number;
        completedCount: number;
        supplementedCount: number;
        reusedHotCommentCount?: number;
        reusedRelatedCommentCount?: number;
        aiGeneratedCount?: number;
        outputReview?: { reviewedCount: number; rejectedCount: number; decisions: Array<{ id: number; keep: boolean; reason?: string }> };
        targetLongCommentCount?: number;
        lengthBuckets?: {
          short: number;
          medium: number;
          long: number;
        };
        targetIntentBuckets?: {
          reaction: number;
          question: number;
          price: number;
          comparison: number;
          skeptical: number;
          experience: number;
          follow: number;
          chatter: number;
        };
        intentBuckets?: {
          reaction: number;
          question: number;
          price: number;
          comparison: number;
          skeptical: number;
          experience: number;
          follow: number;
          chatter: number;
        };
        lowSignalRejectedCount?: number;
        syntheticRejectedCount?: number;
        nearDuplicateRejectedCount?: number;
        repeatedStyleRejectedCount?: number;
        entityCorrectedCount?: number;
        unsupportedEntityRejectedCount?: number;
        transportRejectedCount?: number;
        nativeEmoteCount?: number;
        targetNativeEmoteCount?: number;
        unsupportedEmoteRejectedCount?: number;
        batches: {
          index: number;
          requestedCount: number;
          parsedCount: number;
          model: string;
          fallback: boolean;
          fallbackReason?: string;
          status?: "completed" | "failed";
          attempts?: number;
        }[];
      };
    };
    items: DraftCommentAsset[];
  };
  danmaku?: {
    generatedAt: string;
    requestedCount: number;
    actualCount?: number;
    partial?: boolean;
    engineVersion?: string;
    usedModel: string;
    fallback: boolean;
    fallbackReason?: string;
    timingBasis?: "source_segments" | "estimated_text" | "none";
    durationSec?: number;
    styleSampleCount?: number;
    styleVideoCount?: number;
    styleTopics?: string[];
    sameSecondRate?: number;
    repeatRate?: number;
    burstShare?: number;
    diagnostics?: {
      batchSize: number;
      batchCount: number;
      parsedCount: number;
      completedCount: number;
      rejectedCount: number;
      batches: {
        index: number;
        requestedCount: number;
        parsedCount: number;
        model: string;
        status: "completed" | "failed";
        attempts: number;
        error?: string;
        retryable?: boolean;
      }[];
    };
    items: DraftDanmakuAsset[];
  };
  cover?: {
    references: DraftCoverReference[];
    images: DraftCoverImage[];
    updatedAt: string;
  };
};

export type WriteAction = "create" | "revise";

export type WriteRevisionScope = "full" | "selection";

export type DraftVersion = {
  sessionId: string;
  batchId?: string;
  parentDraftId?: string;
  revision: number;
  instruction?: string;
  contextFingerprint: string;
  promptVersion: string;
  origin: "generated" | "revision" | "manual_edit";
};

export type AccountWriteStyleReference = {
  targetType: "account";
  platform: Platform;
  accountId: string;
  accountName: string;
  videoIds?: string[];
};

export type ProjectWriteStyleReference = {
  targetType: "project";
  projectId: string;
  projectName: string;
  sourceAccountIds?: string[];
  sourceMaterialIds?: string[];
};

export type WriteStyleReference = AccountWriteStyleReference | ProjectWriteStyleReference;

export type WriteStyleReferenceInput =
  | Pick<AccountWriteStyleReference, "targetType" | "platform" | "accountId">
  | Pick<ProjectWriteStyleReference, "targetType" | "projectId">;

type DraftBase = {
  id: string;
  title: string;
  mode: "topic" | "rewrite";
  prompt: string;
  originalSourceInput?: string;
  input?: string;
  supportDocLinks?: string;
  brief?: string;
  research?: string;
  sourceDigest?: WriteSourceDigest;
  styleRefs?: WriteStyleReference[];
  writerContext?: import("./writer-context").WriterContextSnapshot;
  version?: DraftVersion;
  content: string;
  assets?: DraftAssets;
  createdAt: string;
  updatedAt: string;
};

export type WriteSourceDigest = {
  resolvedSourceText?: string;
  materialCount: number;
  linkCount: number;
  textMaterialCount: number;
  onlyLinkCount: number;
  supportDocProvided?: boolean;
  webResearchEnabled?: boolean;
};

export type AccountDraft = DraftBase & {
  targetType?: "account";
  platform: Platform;
  accountId: string;
  accountName: string;
  styleRef: {
    platform: Platform;
    accountId: string;
    accountName: string;
    videoIds?: string[];
  };
};

export type ProjectDraft = DraftBase & {
  targetType: "project";
  projectId: string;
  projectName: string;
  styleRef: {
    projectId: string;
    projectName: string;
    sourceAccountIds?: string[];
    sourceMaterialIds?: string[];
  };
};

export type Draft = AccountDraft | ProjectDraft;

type DraftSummaryBase = {
  id: string;
  title: string;
  mode: "topic" | "rewrite";
  version?: DraftVersion;
  createdAt: string;
  updatedAt: string;
};

export type AccountDraftSummary = DraftSummaryBase & {
  targetType?: "account";
  platform: Platform;
  accountId: string;
  accountName: string;
};

export type ProjectDraftSummary = DraftSummaryBase & {
  targetType: "project";
  projectId: string;
  projectName: string;
};

export type DraftSummary = AccountDraftSummary | ProjectDraftSummary;

export type AccountDraftInput = Omit<AccountDraft, "id" | "createdAt" | "updatedAt">;

export type ProjectDraftInput = Omit<ProjectDraft, "id" | "createdAt" | "updatedAt">;

export type DraftInput = AccountDraftInput | ProjectDraftInput;

export type Project = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  sourceAccountIds: string[];
  sourceMaterialIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectSourceAccount = {
  id: string;
  name: string;
  platform: Platform;
  videoCount: number;
  transcriptCount: number;
};

export type VideoListItem = Omit<Video, "raw" | "hotlistTrend" | "hotlistSurge">;

export type AccountListItem = Account & {
  videoCount: number;
  transcriptCount: number;
  missingTranscriptCount: number;
  draftCount: number;
  styleStatus: "not_generated" | "ready" | "fallback" | "manual";
  styleUpdatedAt?: string;
};

export type TranscriptVersion = {
  id: string;
  createdAt: string;
  revision: string;
  preview: string;
};

export type AccountSummary = Account & {
  videoCount: number;
  transcriptCount: number;
  draftCount: number;
  style: string;
  videos: Video[];
  drafts: Draft[];
};

export type AccountDetail = Omit<AccountSummary, "videos" | "style"> & {
  style?: string;
  videos: VideoListItem[];
};

export type ProjectListItem = Project & {
  sourceAccounts: ProjectSourceAccount[];
  sourceMaterialCount: number;
};

export type ProjectSummary = Project & {
  style: string;
  sourceAccounts: ProjectSourceAccount[];
  sourceMaterials: CopySource[];
  sourceMaterialCount: number;
};

export type ProjectDetail = Omit<ProjectSummary, "style"> & {
  style?: string;
};

export type CopySourceStatus = "completed" | "failed";

export type CopySourceMaterialAnalysis = {
  mode: "multimodal" | "textual";
  status: "completed" | "skipped" | "failed";
  summary: string;
  visualNotes?: string;
  structureNotes?: string;
  titleNotes?: string;
  frameCount?: number;
  fallbackReason?: string;
  error?: string;
  generatedAt: string;
};

export type CopySource = {
  id: string;
  title: string;
  platform: Platform | "unknown";
  url: string;
  resolvedUrl?: string;
  transcript: string;
  transcriptPath: string;
  source: "platform_subtitle" | "volcengine" | "metadata" | "manual";
  status: CopySourceStatus;
  error?: string;
  fallback?: boolean;
  fallbackReason?: string;
  materialAnalysis?: CopySourceMaterialAnalysis;
  projectIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type EngagementSourceType = "draft" | "text" | "url";

export type EngagementGenerationOptions = {
  includeComments: boolean;
  commentCount: number;
  includeDanmaku: boolean;
  danmakuCount: number;
  targetPlatform?: Platform;
};

export type EngagementGenerationRequest = EngagementGenerationOptions & (
  | { sourceType: "draft"; draftId: string }
  | { sourceType: "text"; title?: string; text: string }
  | { sourceType: "url"; url: string }
  | { sourceType: "record"; recordId: string }
);

export type EngagementRecord = {
  id: string;
  sourceType: EngagementSourceType;
  title: string;
  sourceAccountName?: string;
  sourceUrl?: string;
  resolvedUrl?: string;
  platform: Platform | "unknown";
  draftId?: string;
  sourceText: string;
  sourceDurationSec?: number;
  sourceSegments?: Array<{ startSec: number; endSec: number; text: string }>;
  options: {
    includeComments: boolean;
    commentCount: number;
    includeDanmaku: boolean;
    danmakuCount: number;
    generationMode?: EngagementGenerationMode;
    targetPlatform?: Platform;
  };
  comments?: NonNullable<DraftAssets["comments"]>;
  danmaku?: NonNullable<DraftAssets["danmaku"]>;
  fallback: boolean;
  fallbackReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type EngagementRecordSummary = Pick<
  EngagementRecord,
  | "id"
  | "sourceType"
  | "title"
  | "sourceAccountName"
  | "sourceUrl"
  | "platform"
  | "draftId"
  | "fallback"
  | "fallbackReason"
  | "createdAt"
  | "updatedAt"
> & {
  commentCount: number;
  danmakuCount: number;
};

export type GrossMarginTier = {
  id: string;
  name: string;
  originalPrice: number;
  maintenanceCost: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type GrossMarginCategory = {
  id: string;
  name: string;
  description?: string;
  tiers: GrossMarginTier[];
  createdAt: string;
  updatedAt: string;
};

export type GrossMarginServiceKind =
  | "play"
  | "like"
  | "douPlus"
  | "mustFire"
  | "coin"
  | "comment"
  | "share"
  | "favorite"
  | "danmaku"
  | "blueLink";

export type GrossMarginPriceOption = {
  id: string;
  service: GrossMarginServiceKind;
  name: string;
  unitPrice: number;
  quantityUnit: string;
  minimumQuantity?: number | null;
  note?: string;
  active?: boolean;
  updatedAt: string;
};

export type GrossMarginPriceTable = {
  platform: Extract<Platform, "bilibili" | "douyin">;
  items: GrossMarginPriceOption[];
  updatedAt: string;
};

export type GrossMarginPriceTableSaveItem = Pick<
  GrossMarginPriceOption,
  "id" | "service" | "name" | "unitPrice" | "quantityUnit" | "note" | "active"
> & {
  minimumQuantity?: number | null;
};

export type GrossMarginAccountPrice = {
  platform: GrossMarginPriceTable["platform"];
  name: string;
  defaultPrice: number;
  priceLabel: string;
  secondaryPrice?: number;
  secondaryPriceLabel?: string;
  douyinId?: string;
  cooperationCode?: string;
  bilibiliUid?: string;
  homepage?: string;
};

export type GrossMarginProjectOrder = {
  id: string;
  month: string;
  platform: GrossMarginPriceTable["platform"];
  accountName: string;
  projectName: string;
  orderAmount: number | null;
  rebateAmount: number | null;
  finalPrice: number | null;
  videoUrl: string;
  date: string;
  warning?: string;
};

export type GrossMarginProjectSource = {
  month: string;
  orders: GrossMarginProjectOrder[];
  fetchedAt?: string;
  stale: boolean;
};

export type GrossMarginReviewTemplate = {
  platform: GrossMarginPriceTable["platform"];
  content: string;
  defaultContent: string;
  customized: boolean;
  updatedAt: string;
};

export type GrossMarginCalculationLine = {
  service: GrossMarginServiceKind;
  label: string;
  optionId: string;
  optionName: string;
  quantity: number;
  unitPrice: number;
  quantityUnit: string;
  total: number;
};

export type GrossMarginMonitorStatus = "pending" | "completed" | "partial" | "failed";

export type GrossMarginMonitorMetric = {
  service: GrossMarginServiceKind;
  label: string;
  target: number;
  current?: number;
  difference: number;
  differencePercent: number;
  highRisk: boolean;
  manualOnly?: boolean;
};

export type GrossMarginMonitorPlaySample = {
  value: number;
  capturedAt: string;
  source: "refresh" | "manual";
};

export type GrossMarginMonitorRecord = {
  id: string;
  revision?: number;
  platform: GrossMarginPriceTable["platform"];
  accountName: string;
  projectId?: string;
  projectName?: string;
  maintenanceProject?: { orderId: string; name: string };
  videoUrl: string;
  videoKey: string;
  title?: string;
  publishedAt?: string;
  sourceText: string;
  targetStats: Partial<Record<GrossMarginServiceKind, number>>;
  currentStats?: Partial<Record<GrossMarginServiceKind, number>>;
  previousStats?: Partial<Record<GrossMarginServiceKind, number>>;
  playSamples?: GrossMarginMonitorPlaySample[];
  metrics: GrossMarginMonitorMetric[];
  maxDifferencePercent: number;
  highRisk: boolean;
  status: GrossMarginMonitorStatus;
  warnings: string[];
  lastRefreshedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type GrossMarginLibrary = {
  root: string;
  tables: GrossMarginPriceTable[];
  templates: GrossMarginReviewTemplate[];
  accounts: GrossMarginAccountPrice[];
  accountSource: "wecom" | "local";
  accountSourceWarning?: string;
  accountSourceFetchedAt?: string;
  accountSourceRefreshing?: boolean;
  accountSourceFallback?: boolean;
  accountSourceFallbackReason?: string;
  monitorRecords: GrossMarginMonitorRecord[];
  monitorProjects: Array<{
    id: string;
    name: string;
    count: number;
    updatedAt: string;
  }>;
};

export type GrossMarginCalculationInput = {
  platform: GrossMarginPriceTable["platform"];
  originalPrice: number;
  discountPrice: number;
  lines: GrossMarginCalculationLine[];
};

export type GrossMarginCalculationResult = {
  errors?: string[];
  originalPrice: number;
  discountPrice: number;
  maintenanceCost: number;
  grossProfit: number;
  grossMarginRate: number;
  rebateRate: number;
  lines: GrossMarginCalculationLine[];
};

export type LibraryOverview = {
  root: string;
  accounts: AccountListItem[];
  projects: ProjectListItem[];
  copySources: CopySource[];
  engagementRecords: EngagementRecord[];
  drafts: Draft[];
  recentAccounts: AccountListItem[];
  recentProjects: ProjectListItem[];
  recentCopySources: CopySource[];
  recentEngagementRecords: EngagementRecord[];
  recentDrafts: Draft[];
};

export type LibraryOverviewResponse = Omit<
  LibraryOverview,
  "recentAccounts" | "recentProjects" | "recentCopySources" | "recentEngagementRecords" | "recentDrafts"
>;

export type CollectResult = {
  account: AccountSummary;
  videos: Video[];
  command: string;
  rawCount: number;
  filteredCount: number;
  dateFilter?: {
    applied: boolean;
    fromDate?: string;
    toDate?: string;
    rawCount: number;
    matchedCount: number;
    filteredOutCount: number;
    missingDateCount: number;
    earliestPublishedAt?: string;
    latestPublishedAt?: string;
  };
};

export type DouyinHotlistAccount = Pick<
  Account,
  "id" | "slug" | "platform" | "name" | "uid" | "sourceUrl" | "avatarUrl" | "createdAt" | "updatedAt" | "lastCollectedAt"
> & {
  videoCount: number;
  recentVideoCount: number;
};

export type DouyinHotlistVideo = Pick<
  Video,
  "id" | "platform" | "title" | "url" | "coverUrl" | "publishedAt" | "stats" | "hotScore"
>;

export type DouyinHotlistItem = {
  rank: number;
  account: Pick<Account, "id" | "platform" | "name" | "uid" | "avatarUrl">;
  video: DouyinHotlistVideo;
  heatScore: number;
  ageHours?: number;
  tags: string[];
  signal: string;
  surge?: DouyinHotlistSurgeHighlight;
};

export type DouyinHotlistSurgeHighlight = {
  label: string;
  reason: string;
  heatDelta: number;
  heatPerHour: number;
  intervalHours: number;
};

export type DouyinHotlistSummary = {
  windowKey: string;
  windowLabel: string;
  windowDays: number;
  windowHours?: number;
  fromDate: string;
  toDate: string;
  accountCount: number;
  staleAccountIds: string[];
  totalVideoCount: number;
  recentVideoCount: number;
  lastRefreshedAt?: string;
  lastFullRefreshAttemptAt?: string;
  lastFullRefreshAt?: string;
};

export type DouyinHotlistGroup = {
  id: string;
  name: string;
  accountIds: string[];
};

export type DouyinHotlistResponse = {
  groups?: DouyinHotlistGroup[];
  groupRevision?: number;
  accounts: DouyinHotlistAccount[];
  items: DouyinHotlistItem[];
  summary: DouyinHotlistSummary;
};

export type DouyinHotlistRefreshAccountResult = {
  accountId: string;
  name: string;
  status: "completed" | "failed" | "unchanged";
  rawCount?: number;
  savedCount?: number;
  observedCount?: number;
  changedCount?: number;
  error?: string;
  mode?: "batch" | "single";
  retried?: boolean;
  retryReason?: string;
};

export type DouyinHotlistRefreshResult = DouyinHotlistResponse & {
  refresh: {
    requested: number;
    completed: number;
    unchanged: number;
    failed: number;
    limit: number;
    accounts: DouyinHotlistRefreshAccountResult[];
  };
};

export type DouyinHotlistRefreshJobResult = Pick<DouyinHotlistRefreshResult, "refresh" | "summary"> & {
  automatic: boolean;
};

export const hotspotSourceTypes = ["official", "news", "video", "community", "social"] as const;

export type HotspotSourceType = (typeof hotspotSourceTypes)[number];

export const hotspotBoards = ["entertainment", "game", "esports", "ai"] as const;

export type HotspotBoard = (typeof hotspotBoards)[number];

export const hotspotMonitorTypes = ["operations", "official", "esports", "breakout"] as const;

export type HotspotMonitorType = (typeof hotspotMonitorTypes)[number];

export type HotspotScoutStatus = "running" | "queued" | "paused" | "failed";

export type HotspotScout = {
  cacheStatus?: "fresh" | "validated" | "network" | "stale";
  id: string;
  board: HotspotBoard;
  name: string;
  scope: string;
  cadence: string;
  sources: string[];
  status: HotspotScoutStatus;
  coverage: number;
  itemCount: number;
  lastCheckedAt?: string;
  error?: string;
};

export type HotspotSignal = {
  inputKind?: "hotlist" | "rss" | "video";
  observedAt?: string;
  metrics?: { rank?: number; likes?: number; comments?: number; views?: number };
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: HotspotSourceType;
  board: HotspotBoard;
  title: string;
  url?: string;
  game: string;
  category: string;
  capturedAt: string;
  publishedAt?: string;
  heat: number;
  trend: string;
  tags: string[];
  summary?: string;
};

export type HotspotStatus = "ready" | "watch" | "risk";

export type HotspotDisplayInfo = {
  kind: HotspotMonitorType;
  subject: string;
  headline: string;
  statusLine: string;
  timeLabel: string;
  sourceLine: string;
  facts: string[];
  primaryAction: string;
};

export type HotspotEvent = {
  eventFingerprint?: string;
  updatedAt?: string;
  development?: string;
  timeline?: Array<{ signalId: string; title: string; source: string; url: string; publishedAt?: string }>;
  gradeLabel?: RadarGrade;
  userRating?: RadarRating;
  entryPoint?: string;
  commentDirection?: string;
  publishedAt?: string;
  retainedUntil?: string;
  id: string;
  board: HotspotBoard;
  monitorType: HotspotMonitorType;
  monitorLabel: string;
  triggerMode: string;
  thresholdHint: string;
  actionWindow: string;
  priorityLabel: string;
  scopeMatches: string[];
  title: string;
  game: string;
  category: string;
  displayInfo: HotspotDisplayInfo;
  status: HotspotStatus;
  score: number;
  freshness: string;
  sources: number;
  summary: string;
  whyNow: string;
  playerFocus: string[];
  angles: string[];
  evidence: string[];
  research: string[];
  risks: string[];
  accounts: string[];
  signalIds: string[];
  sourceIds?: string[];
};

export type HotspotBoardStat = {
  board: HotspotBoard;
  sourceCount: number;
  completedSourceCount: number;
  failedSourceCount: number;
  signalCount: number;
  hotspotCount: number;
  readyCount: number;
  averageScore: number;
  topScore: number;
};

export type HotspotRadarSummary = {
  sourceCount: number;
  completedSourceCount: number;
  failedSourceCount: number;
  signalCount: number;
  hotspotCount: number;
  readyCount: number;
  averageScore: number;
  boardStats: HotspotBoardStat[];
  generatedAt: string;
};

export type HotspotRadarResponse = {
  collection?: { generatedAt: string; signalCount: number; status: "collected" | "analyzing" | "completed" | "failed" | "cancelled"; error?: string; analyzedCount: number; candidateCount: number };
  provisionalHotspots?: HotspotEvent[];
  schemaVersion?: number;
  analysis?: RadarAnalysis;
  dailyReport?: RadarDailyReport;
  generatedAt: string;
  scouts: HotspotScout[];
  signals: HotspotSignal[];
  hotspots: HotspotEvent[];
  summary: HotspotRadarSummary;
};

export type HotspotRadarRefreshResult = HotspotRadarResponse & {
  refresh: {
    requested: number;
    completed: number;
    failed: number;
    sources: Array<{
      id: string;
      board: HotspotBoard;
      name: string;
      status: "completed" | "failed";
      itemCount: number;
      error?: string;
    }>;
  };
};

export type WriteResult = {
  content: string;
  research?: string;
  contextFingerprint?: string;
  sourceDigest?: WriteSourceDigest;
  draft?: Draft;
  usedModel: string;
  fallback: boolean;
  fallbackReason?: string;
};

export type WriteVariantResult = WriteResult & {
  styleKey: string;
  styleTitle: string;
  styleReference: WriteStyleReference;
};

export type WriteVariantFailure = {
  styleKey: string;
  styleTitle: string;
  styleReference: WriteStyleReference;
  error: string;
};

export type WriteBatchResult = {
  kind: "write-batch";
  results: WriteVariantResult[];
  failures: WriteVariantFailure[];
  research?: string;
  sourceDigest?: WriteSourceDigest;
};

export type WriteGenerationResult = WriteResult | WriteBatchResult;

export type WriterSourceFileImport = {
  name: string;
  mimeType: string;
  text: string;
  originalCharacters: number;
  truncated: boolean;
};

export type BatchTranscribeResult = {
  account: AccountSummary;
  requested: number;
  completed: number;
  skipped: number;
  failed: number;
  timings?: Array<{
    stage: string;
    ms: number;
  }>;
  style?: string;
  styleUpdated?: boolean;
  styleError?: string;
  fallback?: boolean;
  fallbackReason?: string;
  usedModel?: string;
  results: Array<{
    videoId: string;
    title: string;
    status: "completed" | "skipped" | "failed";
    source?: Video["transcriptSource"] | string;
    error?: string;
    timings?: Array<{
      stage: string;
      ms: number;
    }>;
  }>;
};

// 保留已移除任务的历史记录类型；新任务由 startJobSchema 限制。
export const jobKinds = [
  "image-prompt-assist",
  "image-generation",
  "image-cover",
  "write-copy",
  "account-style",
  "project-style",
  "transcribe-video",
  "batch-transcribe",
  "engagement",
  "hotlist-refresh",
  "collect-account",
  "single-video-transcribe",
  "publish-copy",
  "hotspot-refresh",
  "gross-margin-refresh"
] as const;

export type JobKind = (typeof jobKinds)[number];

export type JobStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export type JobResultRef = {
  id?: string;
  href: string;
  label: string;
};

export type JobEvent = {
  at: string;
  status: JobStatus;
  stage?: string;
  message: string;
  progress: number;
};

export type JobDataChange = {
  resource: "image-generation" | "library-account" | "douyin-hotlist" | "gross-margin" | "hotspots" | "drafts" | "engagement";
  at: string;
  accountId?: string;
  videoId?: string;
  recordId?: string;
};

export type JobScope = {
  canvasId?: string;
  targetType?: "account" | "project" | "draft" | "engagement" | "url" | "text" | "hotlist" | "hotspot" | "gross-margin";
  platform?: Platform;
  accountId?: string;
  projectId?: string;
  videoId?: string;
  draftId?: string;
  engagementRecordId?: string;
  sourceKey?: string;
};

export type JobRecord = {
  schemaVersion?: number;
  /** 只在读取时附加；保留不兼容恢复参数的原文件。 */
  recoveryError?: string;
  id: string;
  kind: JobKind;
  status: JobStatus;
  title: string;
  inputSummary?: string;
  scope?: JobScope;
  stage?: string;
  message: string;
  progress: number;
  href?: string;
  partialText?: string;
  resultRef?: JobResultRef;
  result?: unknown;
  resultCompacted?: boolean;
  resultSizeBytes?: number;
  events?: JobEvent[];
  dataRevision?: number;
  dataChange?: JobDataChange;
  attempt?: number;
  resumedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type JobListItem = Omit<JobRecord, "partialText" | "result"> & {
  hasPartialText?: boolean;
  hasResult?: boolean;
};

export type JobListResponse = {
  readErrors?: string[];
  recoveryErrors?: Record<string, string>;
  jobs: JobListItem[];
  removedJobIds: string[];
  cursor: string;
  reset: boolean;
};

export type LibraryTrashOperationStatus = "prepared" | "committed" | "rolled_back" | "restored" | "rollback_failed";

export type LibraryTrashOperation = {
  version: 1;
  id: string;
  kind: string;
  status: LibraryTrashOperationStatus;
  targets: Array<{
    path: string;
    kind: "file" | "directory";
  }>;
  backups: Array<{
    path: string;
    beforeHash: string;
    afterHash?: string | null;
  }>;
  createdAt: string;
  completedAt?: string;
  restoredAt?: string;
  error?: string;
};

export type JobStartInput =
  | { kind: "image-prompt-assist"; title?: string; inputSummary?: string; href?: string; input: ImagePromptAssistInput }
  | { kind: "image-generation"; title?: string; inputSummary?: string; href?: string; input: ImageGenerationInput }
  | {
      kind: "write-copy";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        action?: WriteAction;
        targetType?: "account";
        platform?: Platform;
        accountId?: string;
        styleRefs?: WriteStyleReferenceInput[];
        mode: Draft["mode"];
        prompt: string;
        originalSourceInput?: string;
        sourceText?: string;
        supportDocLinks?: string;
        save?: boolean;
        useWebResearch?: boolean;
        parentDraftId?: string;
        revisionTargets?: Array<{ parentDraftId: string; currentContent: string }>;
        currentContent?: string;
        revisionInstruction?: string;
        revisionScope?: WriteRevisionScope;
        revisionMode?: "edit" | "recalibrate";
        selectedText?: string;
      };
    }
  | {
      kind: "account-style";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        platform: Platform;
        accountId: string;
        force?: boolean;
      };
    }
  | {
      kind: "transcribe-video";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        platform: Platform;
        accountId: string;
        videoId: string;
        mediaUrl?: string;
        allowRemoteDownload?: boolean;
      };
    }
  | {
      kind: "batch-transcribe";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        platform: Platform;
        accountId: string;
        limit: number | "all";
        videoIds?: string[];
        updateStyle?: boolean;
      };
    }
  | {
      kind: "hotlist-refresh";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        accountIds?: string[];
        limit?: number;
        window: string;
        automatic?: boolean;
      };
    }
  | {
      kind: "collect-account";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        platform: Platform;
        name: string;
        uidOrUrl?: string;
        limit: number;
        order: CollectOrder;
        fromDate?: string;
        toDate?: string;
      };
    }
  | {
      kind: "single-video-transcribe";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        url: string;
        titleHint?: string;
      };
    }
  | {
      kind: "publish-copy";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        platform: Platform | "both";
        sourceText: string;
        topicHint?: string;
        candidateCount?: number;
      };
    }
  | {
      kind: "hotspot-refresh";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: { retryReport?: boolean; continueAnalysis?: boolean; trendRadarIds?: string[]; native?: import("./trendradar-native-types").TrendRadarSettings };
    }
  | {
      kind: "gross-margin-refresh";
      title?: string;
      inputSummary?: string;
      href?: string;
      input: {
        recordIds?: string[];
        syncProjects?: boolean;
      };
    }
  | {
      kind: "engagement";
      checkpointId?: string;
      title?: string;
      inputSummary?: string;
      href?: string;
      input: EngagementGenerationRequest;
    };
