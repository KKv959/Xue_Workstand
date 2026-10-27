import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { deleteDrafts, getDraftSummaries, resolveDraft, saveDraft, updateDraftTitle } from "@/lib/storage";
import { platforms } from "@/lib/types";
import { writerContextSchema } from "@/lib/writer-context";
import { listJobs } from "@/lib/jobs";
import { savedBatchSessions, selectWriterBatchDrafts } from "@/lib/writer-history-batch";

export const runtime = "nodejs";

const disallowedDraftAssetsSchema = z.never({
  invalid_type_error: "草稿资产只能通过评论、弹幕或封面资产接口维护。"
}).optional();

const draftStyleReferenceSchema = z.discriminatedUnion("targetType", [
  z.object({
    targetType: z.literal("account"),
    platform: z.enum(platforms),
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

const draftContextFields = {
  writerContext: writerContextSchema.optional(),
  brief: z.string().optional(),
  research: z.string().max(120_000).optional(),
  styleRefs: z.array(draftStyleReferenceSchema).min(1).optional(),
  sourceDigest: z.object({
    resolvedSourceText: z.string().optional(),
    materialCount: z.number().int().min(0),
    linkCount: z.number().int().min(0),
    textMaterialCount: z.number().int().min(0),
    onlyLinkCount: z.number().int().min(0),
    supportDocProvided: z.boolean().optional(),
    webResearchEnabled: z.boolean().optional()
  }).optional(),
  version: z.object({
    sessionId: z.string().min(1),
    batchId: z.string().min(1).max(100).optional(),
    parentDraftId: z.string().min(1).optional(),
    revision: z.number().int().min(1),
    instruction: z.string().max(4_000).optional(),
    contextFingerprint: z.string().min(1).max(80),
    promptVersion: z.string().min(1).max(80),
    origin: z.enum(["generated", "revision", "manual_edit"])
  }).optional()
};

const accountDraftSchema = z.object({
  targetType: z.literal("account").optional(),
  platform: z.enum(platforms),
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(["topic", "rewrite"]),
  prompt: z.string().min(1),
  originalSourceInput: z.string().optional(),
  input: z.string().optional(),
  supportDocLinks: z.string().optional(),
  ...draftContextFields,
  content: z.string().min(1),
  assets: disallowedDraftAssetsSchema,
  styleRef: z.object({
    platform: z.enum(platforms),
    accountId: z.string(),
    accountName: z.string(),
    videoIds: z.array(z.string()).optional()
  })
});

const projectDraftSchema = z.object({
  targetType: z.literal("project"),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(["topic", "rewrite"]),
  prompt: z.string().min(1),
  originalSourceInput: z.string().optional(),
  input: z.string().optional(),
  supportDocLinks: z.string().optional(),
  ...draftContextFields,
  content: z.string().min(1),
  assets: disallowedDraftAssetsSchema,
  styleRef: z.object({
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    sourceAccountIds: z.array(z.string()).optional(),
    sourceMaterialIds: z.array(z.string()).optional()
  })
});

const schema = z.union([accountDraftSchema, projectDraftSchema]);
const deleteSchema = z.object({
  draftIds: z.array(z.string().min(1)).min(1)
});
const updateSchema = z.object({
  draftId: z.string().min(1),
  title: z.string().trim().min(1)
});

export async function GET(request: Request) {
  return apiJson(async () => {
    const params = new URL(request.url).searchParams;
    const draftId = params.get("draftId")?.trim();
    if (draftId) {
      const draft = (await resolveDraft(draftId)).draft;
      if (params.get("includeBatch") !== "1") return { draft };
      let sessions: string[] = [];
      if (!draft.version?.batchId) {
        for (const job of await listJobs()) {
          if (job.kind !== "write-copy") continue;
          sessions = savedBatchSessions(job.result, draft);
          if (sessions.length) break;
        }
      }
      const summaries = selectWriterBatchDrafts(draft, await getDraftSummaries(), sessions);
      const batch = [];
      // Keep filesystem reads bounded even for unusually large historical batches.
      for (const summary of summaries) batch.push(summary.id === draft.id ? draft : (await resolveDraft(summary.id)).draft);
      return { draft, batch };
    }
    return { drafts: await getDraftSummaries() };
  }, {
    fallbackMessage: "读取草稿失败",
    status: 500
  });
}

export async function POST(request: Request) {
  return apiJson(async () => saveDraft(await parseJsonBody(request, schema)), {
    fallbackMessage: "保存草稿失败"
  });
}

export async function DELETE(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, deleteSchema);
    return deleteDrafts(input.draftIds);
  }, {
    fallbackMessage: "删除草稿失败"
  });
}

export async function PATCH(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, updateSchema);
    return updateDraftTitle(input.draftId, input.title);
  }, {
    fallbackMessage: "更新草稿名称失败"
  });
}
