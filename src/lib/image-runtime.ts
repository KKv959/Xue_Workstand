import { z } from "zod";
import { fetch as undiciFetch, ProxyAgent, FormData } from "undici";

type ImageServiceErrorKind = "auth" | "quota" | "rate_limit" | "model_unavailable" | "request" | "server";

class ImageServiceError extends Error {
  constructor(message: string, readonly kind: ImageServiceErrorKind, readonly status: number) {
    super(message);
    this.name = "ImageServiceError";
  }
}

export function imageConfig(profileId = "default") {
  const base = {
    apiKey: process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: (process.env.IMAGE_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.IMAGE_MODEL || "gpt-image-2",
    size: process.env.IMAGE_SIZE || "2048x1152",
    quality: process.env.IMAGE_QUALITY || "medium",
    format: normalizeImageFormat(process.env.IMAGE_FORMAT),
    proxyUrl: process.env.IMAGE_PROXY_URL || process.env.CHAT_PROXY_URL || ""
  };
  if (profileId === "default") return base;
  const profile = imageProfiles().find((entry) => entry.id === profileId);
  if (!profile) throw new Error("所选图片模型配置不存在，请刷新页面重新选择。");
  return { ...base, apiKey: profile.apiKey, baseUrl: profile.baseUrl.replace(/\/$/, ""), model: profile.model, proxyUrl: profile.proxyUrl ?? base.proxyUrl };
}

const profileSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).refine((id) => id !== "default"),
  resolution: z.enum(["1080p", "2k", "4k"]).default("1080p"),
  label: z.string().min(1), model: z.string().min(1), baseUrl: z.string().url(), apiKey: z.string().min(1), proxyUrl: z.string().optional()
}));
function imageProfiles() {
  try {
    const profiles = profileSchema.parse(JSON.parse(process.env.IMAGE_PROFILES || "[]"));
    if (new Set(profiles.map((p) => p.id)).size !== profiles.length) throw new Error();
    return profiles;
  } catch { throw new Error("IMAGE_PROFILES 配置格式无效，请检查模型 ID、地址和密钥配置。"); }
}
export function publicImageProfiles() {
  const base = imageConfig();
  return [{ id: "default", label: process.env.IMAGE_LABEL || base.model, model: base.model, resolution: "1080p" as const, configured: Boolean(base.apiKey) }, ...imageProfiles().map(({ id, label, model, apiKey, resolution }) => ({ id, label, model, resolution, configured: Boolean(apiKey) }))];
}

export function defaultImageProfileId() {
  const profileId = process.env.IMAGE_DEFAULT_PROFILE?.trim() || "default";
  imageConfig(profileId);
  return profileId;
}

function normalizeImageFormat(value?: string): "jpeg" | "png" | "webp" {
  return value === "png" || value === "webp" ? value : "jpeg";
}

export async function callImageApi(input: {
  config: ReturnType<typeof imageConfig>;
  prompt: string;
  referenceFiles: Array<{ name: string; bytes: Buffer; contentType: string }>;
  signal?: AbortSignal;
}) {
  if (!input.config.apiKey) throw new Error("未配置 IMAGE_API_KEY，无法生成图片。");
  const timeout = AbortSignal.timeout(300_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const dispatcher = input.config.proxyUrl ? new ProxyAgent(input.config.proxyUrl) : undefined;
  try {
    signal.throwIfAborted();
    const params = { model: input.config.model, prompt: input.prompt, size: input.config.size, quality: input.config.quality, output_format: input.config.format, n: 1 };
    const editing = input.referenceFiles.length > 0;
    const form = new FormData();
    if (editing) {
      for (const [key, value] of Object.entries(params)) form.set(key, String(value));
      for (const file of input.referenceFiles) {
        form.append("image[]", new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.name);
      }
    }
    const response = await undiciFetch(`${input.config.baseUrl}${editing ? "/images/edits" : "/images/generations"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.config.apiKey}`, ...(!editing ? { "Content-Type": "application/json" } : {}) },
      body: editing ? form : JSON.stringify(params), signal, dispatcher
    });
    if (!response.ok) {
      const providerError = await readProviderError(response);
      throw toImageServiceError(response.status, input.config.model, providerError);
    }
    const data = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
    const first = data.data?.[0];
    if (first?.b64_json) {
      if (first.b64_json.length > 56 * 1024 * 1024) throw new Error("模型返回图片超过 40MB，请降低图片尺寸。");
      return Buffer.from(first.b64_json, "base64");
    }
    if (first?.url) {
      const url = new URL(first.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error("图片服务返回的下载地址无效。");
      const remote = await undiciFetch(url, { signal, dispatcher });
      if (!remote.ok) { await remote.body?.cancel(); throw new Error(`下载生成图片失败（${remote.status}），请检查中转服务。`); }
      const bytes = Buffer.from(await remote.arrayBuffer());
      if (bytes.length > 40 * 1024 * 1024) throw new Error("模型返回图片超过 40MB，请降低图片尺寸。");
      return bytes;
    }
    throw new Error("图片模型没有返回可保存的图片，请检查中转服务响应。");
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (timeout.aborted) throw new Error("图片生成超过 5 分钟，请检查服务状态后重试。");
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("图片服务连接失败或响应无效，请检查服务地址、代理设置和网络。");
    throw error;
  } finally {
    await dispatcher?.close();
  }
}

async function readProviderError(response: Awaited<ReturnType<typeof undiciFetch>>) {
  const reader = response.body?.getReader();
  if (!reader) return { code: "", message: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 16 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = 16 * 1024 - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown };
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as { code?: unknown; message?: unknown } : parsed;
    return {
      code: typeof error.code === "string" ? error.code.slice(0, 100) : "",
      message: typeof error.message === "string" ? error.message.slice(0, 500) : typeof parsed.error === "string" ? parsed.error.slice(0, 500) : ""
    };
  } catch {
    return { code: "", message: "" };
  }
}

function toImageServiceError(status: number, model: string, provider: { code: string; message: string }) {
  const detail = `${provider.code} ${provider.message}`;
  // 中转服务也会用 403 表示预扣费失败，优先识别明确的额度错误。
  if (/insufficient[_ -](?:user[_ -])?quota|insufficient[_ -]balance|余额不足|额度不足|预扣费额度失败/i.test(detail)
    || (status === 429 && /insufficient|quota|balance|billing|credit|余额|额度|预扣费/i.test(detail))) {
    return new ImageServiceError("图片服务额度不足，请在中转服务补充余额或更换可用密钥。", "quota", status);
  }
  if (status === 401 || status === 403) return new ImageServiceError("图片模型鉴权失败，请检查密钥及该模型的使用权限。", "auth", status);
  if (/model[_ -]?not[_ -]?found|no available channel/i.test(detail)) {
    return new ImageServiceError(`图片服务当前没有可用的 ${model} 通道。`, "model_unavailable", status);
  }
  if (status === 429) {
    if (/rate|limit|too many|频繁|限流/i.test(detail)) {
      return new ImageServiceError("图片服务请求过于频繁，请稍后重试。", "rate_limit", status);
    }
    return new ImageServiceError("图片服务返回 429，可能正在限流或当前额度不足。", "rate_limit", status);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ImageServiceError(`图片服务拒绝请求（${status}），请确认模型名、尺寸、质量及参考图接口是否受支持。`, "request", status);
  }
  return new ImageServiceError(`图片服务返回错误（${status}），请稍后重试或检查中转服务状态。`, "server", status);
}

export function getImageRuntimeConfig() {
  const config = imageConfig();
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    size: config.size,
    quality: config.quality,
    proxyConfigured: Boolean(config.proxyUrl),
    configured: Boolean(config.apiKey)
  };
}
