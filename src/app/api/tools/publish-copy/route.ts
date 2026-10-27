import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { generatePublishCopy } from "@/lib/publish-copy";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(["bilibili", "douyin", "both"]).default("both"),
  sourceText: z.string().min(1, "请先粘贴原文案。"),
  topicHint: z.string().optional(),
  candidateCount: z.number().int().min(1).max(10).optional()
});

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    return generatePublishCopy(input, { signal: request.signal });
  }, {
    fallbackMessage: "标题和发布文案生成失败"
  });
}
