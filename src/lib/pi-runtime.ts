import { z } from "zod";

export const piRequestSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(1_500_000) }).strict()).min(1).max(256),
  images: z.array(z.string().regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/)).max(128).optional(),
  maxOutputTokens: z.number().int().positive().max(200_000).optional()
}).strict();
export type PiRequest = z.infer<typeof piRequestSchema>;
export type PiOptions = { signal?: AbortSignal; onDelta?: (text: string) => void };
export const piResultSchema = z.object({
  text: z.string().min(1), model: z.string(), provider: z.string(), wireApi: z.string(),
  reasoningEffort: z.string(), ok: z.literal(true), fallback: z.literal(false)
});
export type PiResult = z.infer<typeof piResultSchema>;
export const piStatusSchema = z.object({ enabled: z.boolean(), configured: z.boolean(), model: z.string().optional(), provider: z.string().optional(), thinking: z.string().optional(), configSignature: z.string().optional(), message: z.string() });
export type PiStatus = z.infer<typeof piStatusSchema>;

export class PiRequestError extends Error {
  constructor(message: string, readonly partialText = "") { super(message); this.name = "PiRequestError"; }
}

export function piEnabled() { return process.env.PI_ENABLED !== "0"; }

export type PiImageRequest = { prompt: string; size: string; quality: string; images: string[] };
export async function piImageConfigured(): Promise<boolean> {
  if (!piEnabled()) return false;
  return (await import("./pi-runtime-local")).piImageConfigured();
}
export async function runPiImage(input: PiImageRequest, signal?: AbortSignal): Promise<Buffer> {
  if (!piEnabled()) throw new Error("订阅服务已关闭，请启用 Pi 或选择图片中转来源");
  return (await import("./pi-runtime-local")).runPiImage(input, signal);
}

export async function runPiModel(input: PiRequest, options: PiOptions = {}): Promise<PiResult> {
  options.signal?.throwIfAborted();
  return (await import("./pi-runtime-local")).runPiModel(piRequestSchema.parse(input), options);
}

export async function getPiStatus(): Promise<PiStatus> {
  if (!piEnabled()) return { enabled: false, configured: false, message: "Pi 已关闭，使用原中转站链路" };
  try {
    return await (await import("./pi-runtime-local")).getPiStatus();
  }
  catch (error) {
    const reason = error instanceof PiRequestError ? error.message : "Pi 配置无法读取，请在 AI 模型配置页面检查";
    return { enabled: true, configured: false, message: `${reason}；当前使用原中转站兜底` };
  }
}
