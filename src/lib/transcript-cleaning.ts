import { Platform } from "./types";
import { piEnabled } from "./pi-runtime";

export type TranscriptCleanResult = {
  text: string;
  usedModel: string;
  fallback: boolean;
  fallbackReason?: string;
};

const TRANSCRIPT_CLEAN_CHUNK_SIZE = 3200;
const CLEAN_TRANSCRIPT_SYSTEM_PROMPT =
  "你是中文 ASR 转写清洗助手。你的任务是把自动转写文本整理成更易读的中文转写稿。必须严格保留原意、事实、信息顺序和口语风格，不得总结、改写成立意文案、补充原文没有的新事实，也不要擅自修正拿不准的人名术语。你可以做的只有：删除明显的表情符号和音乐提示，去掉重复乱码或口头噪声，补齐标点和合理分段。只输出清洗后的正文纯文本，不要解释。";

export async function cleanTranscriptText(input: {
  platform: Platform;
  title?: string;
  text: string;
  useModel?: boolean;
  signal?: AbortSignal;
}): Promise<TranscriptCleanResult> {
  throwIfAborted(input.signal);
  const localCleaned = finalizeTranscriptText(input.text);
  if (!localCleaned) {
    return {
      text: "",
      usedModel: "local-cleaner",
      fallback: true,
      fallbackReason: "原始转写结果为空，无法清洗。"
    };
  }

  const shouldUseModel = input.useModel ?? process.env.TRANSCRIPT_CLEAN_USE_MODEL === "true";
  if (!shouldUseModel) {
    return {
      text: localCleaned,
      usedModel: "local-cleaner",
      fallback: false
    };
  }

  const { chatComplete, getChatRuntimeConfig } = await import("./ai");
  const runtime = getChatRuntimeConfig();
  if (!piEnabled() && !runtime.configured) {
    return {
      text: localCleaned,
      usedModel: "local-cleaner",
      fallback: true,
      fallbackReason: "未配置对话模型，已使用本地规则清洗。"
    };
  }

  try {
    const chunks = splitTranscriptChunks(localCleaned, TRANSCRIPT_CLEAN_CHUNK_SIZE);
    const cleanedChunks: string[] = [];
    const usedModels = new Set<string>();
    const fallbackReasons = new Set<string>();

    for (const [index, chunk] of chunks.entries()) {
      throwIfAborted(input.signal);
      const result = await chatComplete([
        {
          role: "system",
          content: CLEAN_TRANSCRIPT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: buildChunkPrompt({
            platform: input.platform,
            title: input.title,
            chunk,
            chunkIndex: index + 1,
            chunkCount: chunks.length
          })
        }
      ], undefined, { policy: "transcript_clean", signal: input.signal });
      throwIfAborted(input.signal);

      usedModels.add(result.model);
      if (result.fallbackReason) fallbackReasons.add(result.fallbackReason);
      const cleanedChunk = finalizeModelOutput(result.text);
      if (!result.ok || !cleanedChunk) {
        return {
          text: localCleaned,
          usedModel: "local-cleaner",
          fallback: true,
          fallbackReason: result.fallbackReason || "清洗模型未返回可用结果，已回退到本地规则清洗。"
        };
      }

      cleanedChunks.push(cleanedChunk);
    }

    const cleanedText = finalizeTranscriptText(cleanedChunks.join("\n\n"));
    if (!cleanedText) {
      return {
        text: localCleaned,
        usedModel: "local-cleaner",
        fallback: true,
        fallbackReason: "清洗模型输出为空，已回退到本地规则清洗。"
      };
    }

    return {
      text: cleanedText,
      usedModel: [...usedModels].join(", "),
      fallback: fallbackReasons.size > 0,
      fallbackReason: [...fallbackReasons].join("；") || undefined
    };
  } catch (error) {
    if (isAbortError(error, input.signal)) throw error;
    return {
      text: localCleaned,
      usedModel: "local-cleaner",
      fallback: true,
      fallbackReason: error instanceof Error ? `清洗模型失败：${error.message}` : "清洗模型失败，已回退到本地规则清洗。"
    };
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("任务已停止");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === "AbortError" || /AbortError|aborted|任务已停止/i.test(error.message));
}

function buildChunkPrompt(input: {
  platform: Platform;
  title?: string;
  chunk: string;
  chunkIndex: number;
  chunkCount: number;
}) {
  return `平台：${input.platform}
标题：${input.title || "未命名视频"}
片段：${input.chunkIndex}/${input.chunkCount}

请清洗下面这段自动转写文本。
要求：
1. 忠实保留原意与顺序，不总结、不改写成文案。
2. 删除像“🎼”“😊”“😡”这类明显噪声和无意义重复。
3. 可以补标点、断句、分段，但不要凭空改人名、术语或剧情。
4. 只输出清洗后的正文。

原始转写：
${input.chunk}`;
}

function splitTranscriptChunks(text: string, maxLength: number) {
  if (text.length <= maxLength) return [text];

  const segments = text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) return [text.slice(0, maxLength)];

  const chunks: string[] = [];
  let current = "";

  for (const segment of segments) {
    if (segment.length > maxLength) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }

      let remaining = segment;
      while (remaining.length > maxLength) {
        const slice = remaining.slice(0, maxLength);
        const splitAt = Math.max(
          slice.lastIndexOf("。"),
          slice.lastIndexOf("！"),
          slice.lastIndexOf("？"),
          slice.lastIndexOf("；"),
          slice.lastIndexOf("，"),
          slice.lastIndexOf("、"),
          slice.lastIndexOf(" ")
        );
        const pivot = splitAt > Math.floor(maxLength * 0.5) ? splitAt + 1 : maxLength;
        chunks.push(remaining.slice(0, pivot).trim());
        remaining = remaining.slice(pivot).trim();
      }

      if (remaining) current = remaining;
      continue;
    }

    const next = current ? `${current}\n${segment}` : segment;
    if (next.length > maxLength) {
      chunks.push(current.trim());
      current = segment;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function finalizeModelOutput(text: string) {
  return finalizeTranscriptText(
    text
      .replace(/^```[\w-]*\s*/u, "")
      .replace(/\s*```$/u, "")
      .replace(/^以下是清洗后的(?:转写稿|正文)?[:：]\s*/u, "")
      .trim()
  );
}

function finalizeTranscriptText(text: string) {
  return normalizeTranscriptWhitespace(stripTranscriptNoise(text))
    .replace(/([。！？!?；;])(?=[^\n])/gu, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTranscriptNoise(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200d\uFE0F]/gu, "")
    .replace(/[\p{Extended_Pictographic}]/gu, " ")
    .replace(/[♪♫♬♩♭♮♯]+/gu, " ")
    .replace(/\b(?:BGM|bgm|music|MUSIC)\b[:：]?\s*/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n");
}

function normalizeTranscriptWhitespace(text: string) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ ]*([，。！？；：、])/gu, "$1")
    .replace(/([，。！？；：、])[ ]*/gu, "$1")
    .replace(/([，。！？；：、,.!?;:])\1+/gu, "$1")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}
