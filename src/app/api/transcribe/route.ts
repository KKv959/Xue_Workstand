import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { transcribeVideo } from "@/lib/transcription";
import { createUrlPreprocessor } from "@/lib/platform-links";
import { platforms } from "@/lib/types";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(platforms),
  accountId: z.string().min(1),
  videoId: z.string().min(1),
  mediaUrl: z.preprocess(createUrlPreprocessor(), z.string().url().refine((value) => /^https?:\/\//i.test(value), "媒体链接只支持 HTTP/HTTPS")).optional(),
  allowRemoteDownload: z.boolean().optional()
});

export async function POST(request: Request) {
  return apiJson(async () => transcribeVideo({
    ...(await parseJsonBody(request, schema)),
    signal: request.signal
  }), {
    fallbackMessage: "转写失败"
  });
}
