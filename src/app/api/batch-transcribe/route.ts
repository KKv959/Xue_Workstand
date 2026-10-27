import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { runBatchTranscribe } from "@/lib/batch-transcribe";
import { platforms } from "@/lib/types";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(platforms),
  accountId: z.string().min(1),
  limit: z.union([z.number().int().min(1), z.literal("all")]).default(5),
  videoIds: z.array(z.string().min(1)).min(1).optional(),
  updateStyle: z.boolean().optional()
});

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    return runBatchTranscribe(input, { signal: request.signal });
  }, {
    fallbackMessage: "批量转写失败"
  });
}
