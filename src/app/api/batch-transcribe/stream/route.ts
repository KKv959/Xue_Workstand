import { z } from "zod";
import { apiError, parseJsonBody } from "@/lib/api-route";
import { runBatchTranscribe } from "@/lib/batch-transcribe";
import { createNdjsonStream } from "@/lib/streaming";
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
  try {
    const input = await parseJsonBody(request, schema);

    const stream = createNdjsonStream(async (emit, signal) => {
      const result = await runBatchTranscribe(input, {
        signal,
        onPrepare() {
          emit({ type: "stage", stage: "prepare", message: "正在读取账号和候选视频", progress: 8 });
        },
        onMediaPreloadStart({ total }) {
          emit({
            type: "stage",
            stage: "media-preload",
            message: `正在预取 ${total} 条抖音视频的媒体地址`,
            progress: 12
          });
        },
        onVideoStart({ index, total, video }) {
          const progress = total ? 18 + Math.round((index / total) * 64) : 70;
          emit({
            type: "stage",
            stage: "transcribe",
            message: `正在处理第 ${index + 1}/${total} 条视频：${video.title}`,
            progress
          });
        },
        onVideoResult(event) {
          emit({ type: "result", data: event });
        },
        onTranscribeComplete({ completed, failed }) {
          emit({
            type: "stage",
            stage: "transcripts-saved",
            message: `转写已同步：新增 ${completed}，失败 ${failed}`,
            progress: 86
          });
        },
        onStyleStart() {
          emit({ type: "stage", stage: "style", message: "正在更新账号风格卡", progress: 88 });
        },
        onFinalize() {
          emit({ type: "stage", stage: "finalize", message: "正在整理转写结果", progress: 98 });
        }
      });
      emit({ type: "result", data: result });
    }, { signal: request.signal });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  } catch (error) {
    return apiError(error, {
      fallbackMessage: "批量转写失败"
    });
  }
}
