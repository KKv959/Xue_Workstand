import { z } from "zod";
import {
  completeCachedAccountStyle,
  completePreparedAccountStyle,
  prepareAccountStyleContext,
  streamStyleResponseTextWithFallback
} from "@/lib/ai";
import { apiError, parseJsonBody } from "@/lib/api-route";
import { createNdjsonStream } from "@/lib/streaming";
import { platforms } from "@/lib/types";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(platforms),
  accountId: z.string().min(1),
  force: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    const input = await parseJsonBody(request, schema);

    const stream = createNdjsonStream(async (emit, signal) => {
      const startedAt = Date.now();
      emit({ type: "stage", stage: "prepare", message: "正在读取账号转写样本", progress: 12 });
      const context = await prepareAccountStyleContext(input.platform, input.accountId, {
        signal,
        force: input.force,
        onAnalysisProgress(progress) {
          const percent = progress.analysisCount
            ? Math.floor((progress.completedCount / progress.analysisCount) * 25)
            : 0;
          emit({
            type: "stage",
            stage: "analysis",
            message: progress.message || `正在分析完整样本 ${progress.completedCount}/${progress.analysisCount}`,
            progress: Math.min(34, 12 + percent)
          });
        }
      });
      const cached = completeCachedAccountStyle(context);
      if (cached) {
        emit({ type: "stage", stage: "cache", message: "样本未变化，已复用现有风格卡", progress: 100 });
        emit({ type: "delta", delta: cached.style });
        emit({ type: "result", data: { ...cached, totalMs: Date.now() - startedAt } });
        return;
      }

      let generated = "";
      let firstDeltaMs: number | undefined;
      emit({
        type: "stage",
        stage: "generate",
        message: context.generationMode === "incremental" ? "正在增量更新账号风格卡" : "正在生成账号风格卡",
        progress: 35
      });
      const result = await streamStyleResponseTextWithFallback({
        messages: context.messages,
        signal,
        onDelta(delta) {
          if (firstDeltaMs === undefined) firstDeltaMs = Date.now() - startedAt;
          generated += delta;
          emit({ type: "delta", delta });
        }
      });

      if (!generated.trim() && result.text) {
        if (firstDeltaMs === undefined) firstDeltaMs = Date.now() - startedAt;
        emit({ type: "delta", delta: result.text });
      }

      emit({ type: "stage", stage: "save", message: "正在写入账号风格卡", progress: 90 });
      const saved = await completePreparedAccountStyle(context, result, {
        firstDeltaMs,
        totalMs: Date.now() - startedAt
      });
      emit({ type: "result", data: saved });
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
      fallbackMessage: "自动总结风格失败"
    });
  }
}
