import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { publishFeishuDocument } from "@/lib/feishu";

export const runtime = "nodejs";

const schema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1)
});

export async function POST(request: Request) {
  return apiJson(async () => publishFeishuDocument(await parseJsonBody(request, schema)), {
    fallbackMessage: "发布飞书文档失败"
  });
}
