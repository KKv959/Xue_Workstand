import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { generateDraftEngagement } from "@/lib/engagement";

export const runtime = "nodejs";

const schema = z.object({
  draftId: z.string().min(1),
  commentCount: z.number().int().min(1).max(200).default(50),
  danmakuCount: z.number().int().min(1).max(300).default(50)
});

export async function POST(request: Request) {
  return apiJson(async () => generateDraftEngagement(await parseJsonBody(request, schema), { signal: request.signal }), {
    fallbackMessage: "生成评论和弹幕失败"
  });
}
