import {
  extractRewriteSourceMaterial,
  RewriteSourceExtraction,
  sourceMaterialNeedsTranscription,
  SourceMaterial
} from "./source-extraction";
import { isSupportedVideoSourceLink, transcribeLinkSource, LinkTranscriptionResult } from "./transcription";

type ResolveRewriteSourceMaterialOptions = {
  linkMode?: "all" | "video-only";
  signal?: AbortSignal;
};

export async function resolveRewriteSourceMaterial(
  input: string,
  options: ResolveRewriteSourceMaterialOptions = {}
): Promise<RewriteSourceExtraction> {
  const extracted = extractRewriteSourceMaterial(input);
  if (!extracted.materials.some((material) => material.urls.length)) return extracted;

  const materials = await Promise.all(
    extracted.materials.map(async (material) => {
      if (!sourceMaterialNeedsTranscription(material)) return material;

      const transcriptBlocks: string[] = [];
      const errors: string[] = [];
      for (const url of material.urls) {
        throwIfAborted(options.signal);
        if (options.linkMode === "video-only" && !isSupportedVideoSourceLink(url)) continue;
        try {
          const result = await transcribeLinkSource({
            url,
            titleHint: material.text,
            signal: options.signal
          });
          if (result.source === "metadata" || !result.text.trim()) {
            throw new Error(result.fallbackReason || "只解析到视频标题，没有取得可用视频文稿。");
          }
          transcriptBlocks.push(formatLinkTranscript(result));
        } catch (error) {
          if (isAbortError(error, options.signal)) throw error;
          errors.push(`${url}：${error instanceof Error ? error.message : "链接转写失败"}`);
        }
      }

      return {
        ...material,
        transcribedText: transcriptBlocks.join("\n\n").trim(),
        transcriptionError: errors.join("\n")
      } satisfies SourceMaterial;
    })
  );

  const linkMaterials = materials.filter((material) => material.urls.length);
  const attemptedLinkMaterials = linkMaterials.filter((material) => material.transcribedText?.trim() || material.transcriptionError?.trim());
  const successfulLinkMaterials = linkMaterials.filter((material) => material.transcribedText?.trim());
  if (attemptedLinkMaterials.length && !successfulLinkMaterials.length) {
    const detail = attemptedLinkMaterials
      .map((material) => material.transcriptionError)
      .filter(Boolean)
      .join("\n");
    throw new Error(`链接视频文稿转写失败${detail ? `：${detail}` : ""}`);
  }

  return {
    ...extracted,
    materials,
    normalizedText: buildResolvedSourceText(materials, input),
    textMaterialCount: materials.filter((material) => (material.transcribedText || material.text).trim()).length
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("任务已停止");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === "AbortError" || /任务已停止|aborted/i.test(error.message));
}

function buildResolvedSourceText(materials: SourceMaterial[], fallback: string) {
  const trimmedFallback = fallback.trim();
  if (!materials.length) return trimmedFallback;

  return materials
    .map((material) => {
      const lines = [`素材 ${material.index}：`];
      if (material.transcribedText) {
        lines.push(material.transcribedText);
      } else {
        if (material.text) lines.push(material.text);
        if (material.urls.length) {
          if (material.transcriptionError) {
            lines.push("链接转写失败，未取得可用视频文稿。");
            lines.push(material.transcriptionError);
          } else if (!material.text) {
            lines.push(`原始链接：${material.urls.join(" ")}`);
          }
        }
      }
      if (material.urls.length) lines.push(`来源链接：${material.urls.join(" ")}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

function formatLinkTranscript(result: LinkTranscriptionResult) {
  const lines = [];
  if (result.title) lines.push(`标题：${result.title}`);
  lines.push(`视频文稿：\n${result.text}`);
  if (result.fallbackReason) lines.push(`转写说明：${result.fallbackReason}`);
  return lines.join("\n");
}
