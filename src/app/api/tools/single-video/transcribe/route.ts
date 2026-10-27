import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { createUrlPreprocessor } from "@/lib/platform-links";
import { transcribeLinkSource } from "@/lib/transcription";

export const runtime = "nodejs";

const schema = z.object({
  url: z.preprocess(createUrlPreprocessor({ kind: "video" }), z.string().url()),
  titleHint: z.string().optional()
});

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    const result = await transcribeLinkSource({
      url: input.url,
      titleHint: input.titleHint,
      analyzeVideo: true,
      signal: request.signal
    });
    return { result };
  }, {
    fallbackMessage: "单条视频文案提取失败"
  });
}
