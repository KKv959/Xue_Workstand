import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { generateEngagement } from "@/lib/engagement";
import { createUrlPreprocessor } from "@/lib/platform-links";
import { deleteEngagementRecords, getEngagementRecordSummaries, resolveEngagementRecord } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const urlSchema = z.preprocess(
  createUrlPreprocessor({ kind: "video" }),
  z.string().url("链接格式不正确，请粘贴完整的 http(s) 地址。")
);

const optionsSchema = {
  includeComments: z.boolean().optional().default(true),
  commentCount: z.number().int().min(1).max(200).optional().default(50),
  includeDanmaku: z.boolean().optional().default(false),
  danmakuCount: z.number().int().min(1).max(300).optional().default(50),
  targetPlatform: z.enum(["bilibili", "douyin"]).optional()
};

const schema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("draft"),
    draftId: z.string().min(1),
    ...optionsSchema
  }),
  z.object({
    sourceType: z.literal("text"),
    title: z.string().optional(),
    text: z.string().min(1),
    ...optionsSchema
  }),
  z.object({
    sourceType: z.literal("url"),
    url: urlSchema,
    ...optionsSchema
  }),
  z.object({
    sourceType: z.literal("record"),
    recordId: z.string().min(1),
    ...optionsSchema
  })
]);
const deleteSchema = z.object({
  recordIds: z.array(z.string().min(1)).min(1)
});

export async function GET(request: Request) {
  return apiJson(async () => {
    const recordId = new URL(request.url).searchParams.get("recordId")?.trim();
    if (recordId) return { record: await resolveEngagementRecord(recordId) };
    return { records: await getEngagementRecordSummaries() };
  }, {
    fallbackMessage: "读取互动素材历史失败"
  });
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    return generateEngagement(input, { signal: request.signal });
  }, {
    fallbackMessage: "生成评论失败"
  });
}

export async function DELETE(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, deleteSchema);
    return deleteEngagementRecords(input.recordIds);
  }, {
    fallbackMessage: "删除互动素材失败"
  });
}
