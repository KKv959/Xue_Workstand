import {
  completePreparedWriteCopy,
  completePreparedWriteVariant,
  prepareWriteCopyBatchContext,
  prepareWriteCopyContext,
  resolveWriteBatchOutcome,
  streamResponseTextWithFallback,
  writeVariantFailure,
  WRITE_COPY_REASONING_EFFORT
} from "@/lib/ai";
import { apiError, parseJsonBody } from "@/lib/api-route";
import { hasSupportDocumentReference } from "@/lib/support-documents";
import { extractRewriteSourceMaterial, splitWriterSourceInput } from "@/lib/source-extraction";
import { createNdjsonStream } from "@/lib/streaming";
import { directWriteCopyInputSchema } from "@/lib/write-validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = await parseJsonBody(request, directWriteCopyInputSchema);

    const stream = createNdjsonStream(async (emit, signal) => {
      const isRevision = input.action === "revise";
      const separatedSourceInput = splitWriterSourceInput(input.sourceText || "", input.supportDocLinks || "");
      const sourceExtraction = extractRewriteSourceMaterial(separatedSourceInput.sourceText);
      emit({
        type: "stage",
        stage: "prepare",
        message: isRevision ? "正在读取当前稿件和版本上下文" : "正在读取风格卡和代表样本",
        progress: 10
      });
      if (!isRevision && input.mode === "rewrite" && sourceExtraction.pendingLinkCount > 0) {
        emit({ type: "stage", stage: "transcribe-links", message: "正在转写链接里的视频文稿", progress: 18 });
      }
      if (!isRevision && hasSupportDocumentReference(separatedSourceInput.supportDocLinks)) {
        emit({
          type: "stage",
          stage: "fetch-support-docs",
          message: "正在准备商单支持文档（已读内容会自动复用）",
          progress: 24
        });
      }
      if (isRevision) {
        const prepared = await prepareWriteCopyContext(input, { signal });
        emit({
          type: "stage",
          stage: "generate",
          message: "正在按本轮要求生成新版本",
          progress: 55
        });
        const result = await streamResponseTextWithFallback({
          policy: "writer_revise",
          messages: prepared.messages,
          reasoningEffort: WRITE_COPY_REASONING_EFFORT,
          signal,
          onRetry(message) { emit({ type: "stage", stage: "generate", message }); },
          onDelta(delta) {
            emit({ type: "delta", delta });
          }
        });
        if (input.save) {
          emit({ type: "stage", stage: "save-draft", message: "正在保存历史记录", progress: 88 });
        }
        const finalResult = await completePreparedWriteCopy({ prepared, result, save: input.save, signal });
        emit({ type: "stage", stage: "finalize", message: "正在整理最终结果", progress: 95 });
        emit({ type: "result", data: finalResult });
        return;
      }

      const batch = await prepareWriteCopyBatchContext(input, { signal, onProgress(message) { emit({ type: "stage", stage: "prepare-style", message, progress: 32 }); } });
      if (input.useWebResearch) {
        emit({
          type: "stage",
          stage: "research",
          message: "联网检索已完成，正在整理资料",
          progress: 35
        });
        if (batch.research) emit({ type: "result", data: { research: batch.research, phase: "research" } });
      }

      const variantCount = batch.variants.length;
      emit({
        type: "stage",
        stage: "generate",
        message: variantCount > 1 ? `正在并发生成 ${variantCount} 篇独立文案` : "正在生成文案",
        progress: 55
      });

      let completedCount = 0;
      const outcomes = await Promise.all(batch.variants.map(async (variant) => {
        try {
          const result = await streamResponseTextWithFallback({
            policy: "writer_generate",
            messages: variant.prepared.messages,
            reasoningEffort: WRITE_COPY_REASONING_EFFORT,
            signal,
            onRetry(message) {
              emit({ type: "stage", stage: "generate", message: `${variant.styleTitle}：${message}` });
            },
            onDelta(delta) {
              if (variantCount === 1) emit({ type: "delta", delta });
            }
          });
          const completed = await completePreparedWriteVariant({
            variant,
            result,
            save: input.save,
            signal
          });
          completedCount += 1;
          emit({
            type: "stage",
            stage: "generate",
            message: variantCount > 1 ? `已完成 ${completedCount}/${variantCount} 篇` : "正在整理生成结果",
            progress: Math.min(90, 55 + Math.floor((completedCount / variantCount) * 34))
          });
          return { result: completed };
        } catch (error) {
          completedCount += 1;
          return { failure: writeVariantFailure(variant, error) };
        }
      }));

      if (input.save) {
        emit({ type: "stage", stage: "save-draft", message: "正在整理已保存的独立草稿", progress: 92 });
      }

      const finalResult = resolveWriteBatchOutcome(batch, outcomes);
      emit({ type: "stage", stage: "finalize", message: "正在整理最终结果", progress: 95 });
      emit({ type: "result", data: finalResult });
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
      fallbackMessage: "生成文案失败"
    });
  }
}
