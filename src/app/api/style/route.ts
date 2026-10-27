import { z } from "zod";
import { generateStyleProfile } from "@/lib/ai";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { saveStyle } from "@/lib/storage";
import { platforms } from "@/lib/types";

export const runtime = "nodejs";

const baseSchema = z.object({
  platform: z.enum(platforms),
  accountId: z.string().min(1),
  force: z.boolean().optional()
});

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, baseSchema);
    return generateStyleProfile(input.platform, input.accountId, { signal: request.signal, force: input.force });
  }, {
    fallbackMessage: "自动总结风格失败"
  });
}

export async function PUT(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, baseSchema.extend({ content: z.string().min(1) }));
    const style = await saveStyle(input.platform, input.accountId, input.content);
    return { style };
  }, {
    fallbackMessage: "保存风格卡失败"
  });
}
