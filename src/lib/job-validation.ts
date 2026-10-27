import { trendRadarSettingsSchema } from "./trendradar-native-types";
import { z } from "zod";
import { imagePromptAssistSchema } from "./image-prompt-assist-types";
import { imageGenerationInputSchema } from "./image-generation-types";
import { createUrlPreprocessor } from "./platform-links";
import { platforms } from "./types";
import { writeCopyInputSchema } from "./write-validation";

const urlSchema = z.preprocess(
  createUrlPreprocessor(),
  z.string().url("链接格式不正确，请粘贴完整的 http(s) 地址。")
);

const writeCopySchema = z.object({
  kind: z.literal("write-copy"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: writeCopyInputSchema
});

const accountStyleSchema = z.object({
  kind: z.literal("account-style"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    platform: z.enum(platforms),
    accountId: z.string().min(1),
    force: z.boolean().optional()
  })
});

const transcribeVideoSchema = z.object({
  kind: z.literal("transcribe-video"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    platform: z.enum(platforms),
    accountId: z.string().min(1),
    videoId: z.string().min(1),
    mediaUrl: urlSchema.optional(),
    allowRemoteDownload: z.boolean().optional()
  })
});

const batchTranscribeSchema = z.object({
  kind: z.literal("batch-transcribe"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    platform: z.enum(platforms),
    accountId: z.string().min(1),
    limit: z.union([z.number().int().min(1), z.literal("all")]).default(5),
    videoIds: z.array(z.string().min(1)).optional(),
    updateStyle: z.boolean().optional()
  })
});

const engagementOptionsSchema = {
  includeComments: z.boolean().optional().default(true),
  commentCount: z.number().int().min(1).max(200).optional().default(50),
  includeDanmaku: z.boolean().optional().default(false),
  danmakuCount: z.number().int().min(1).max(300).optional().default(50),
  targetPlatform: z.enum(platforms).optional()
};

const engagementSchema = z.object({
  kind: z.literal("engagement"),
  checkpointId: z.string().uuid().optional(),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.discriminatedUnion("sourceType", [
    z.object({
      sourceType: z.literal("draft"),
      draftId: z.string().min(1),
      ...engagementOptionsSchema
    }),
    z.object({
      sourceType: z.literal("text"),
      title: z.string().optional(),
      text: z.string().min(1),
      ...engagementOptionsSchema
    }),
    z.object({
      sourceType: z.literal("url"),
      url: urlSchema,
      ...engagementOptionsSchema
    }),
    z.object({
      sourceType: z.literal("record"),
      recordId: z.string().min(1),
      ...engagementOptionsSchema
    })
  ])
});

const hotlistRefreshSchema = z.object({
  kind: z.literal("hotlist-refresh"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    accountIds: z.array(z.string().min(1)).min(1).optional(),
    limit: z.number().int().min(1).max(120).optional(),
    window: z.string().min(1),
    automatic: z.boolean().optional()
  })
});

const collectAccountSchema = z.object({
  kind: z.literal("collect-account"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    platform: z.enum(platforms),
    name: z.string().min(1),
    uidOrUrl: z.string().optional(),
    limit: z.number().int().min(1).max(50),
    order: z.enum(["views", "likes", "favorites", "comments", "pubdate"]),
    fromDate: z.string().optional(),
    toDate: z.string().optional()
  })
});

const singleVideoTranscribeSchema = z.object({
  kind: z.literal("single-video-transcribe"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    url: urlSchema,
    titleHint: z.string().optional()
  })
});

const publishCopySchema = z.object({
  kind: z.literal("publish-copy"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    platform: z.enum(["bilibili", "douyin", "both"]).default("both"),
    sourceText: z.string().min(1, "请先粘贴原文案。"),
    topicHint: z.string().optional(),
    candidateCount: z.number().int().min(1).max(10).optional()
  })
});

const hotspotRefreshSchema = z.object({
  kind: z.literal("hotspot-refresh"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({ native: trendRadarSettingsSchema.optional(), retryReport: z.boolean().optional(), continueAnalysis: z.boolean().optional(), trendRadarIds: z.array(z.string().regex(/^trend:(hotlist|rss):[a-f0-9]{24}$/)).min(1).max(24).optional() }).refine(value => [value.retryReport, value.continueAnalysis, Boolean(value.trendRadarIds), Boolean(value.native)].filter(Boolean).length <= 1, "重试日报、继续分析和选择候选不能同时执行")
});

const grossMarginRefreshSchema = z.object({
  kind: z.literal("gross-margin-refresh"),
  title: z.string().optional(),
  inputSummary: z.string().optional(),
  href: z.string().optional(),
  input: z.object({
    recordIds: z.array(z.string().trim().min(1)).optional(),
    syncProjects: z.boolean().optional()
  }).superRefine((input, ctx) => {
    if (input.syncProjects && input.recordIds) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "同步项目报价不能同时刷新监控记录" });
  })
});

export const startJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image-prompt-assist"), title: z.string().optional(), inputSummary: z.string().optional(), href: z.string().optional(), input: imagePromptAssistSchema }),
  z.object({ kind: z.literal("image-generation"), title: z.string().optional(), inputSummary: z.string().optional(), href: z.string().optional(), input: imageGenerationInputSchema }),
  writeCopySchema,
  accountStyleSchema,
  transcribeVideoSchema,
  batchTranscribeSchema,
  hotlistRefreshSchema,
  collectAccountSchema,
  singleVideoTranscribeSchema,
  publishCopySchema,
  hotspotRefreshSchema,
  grossMarginRefreshSchema,
  engagementSchema
]);
