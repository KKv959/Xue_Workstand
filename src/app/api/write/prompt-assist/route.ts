import { apiJson, parseJsonBody } from "@/lib/api-route";
import { assistWriterPrompt, writerPromptAssistSchema } from "@/lib/writer-prompt-assist";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiJson(async () => {
    const { prompt } = await parseJsonBody(request, writerPromptAssistSchema);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
    try { return await assistWriterPrompt(prompt, signal); }
    catch (error) {
      if (signal.aborted) throw new Error("润色已取消或超时，原要求已保留，请重试。");
      throw error;
    }
  }, { fallbackMessage: "写作要求润色失败，请重试。" });
}
