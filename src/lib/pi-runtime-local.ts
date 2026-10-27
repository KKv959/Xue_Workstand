import path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Context, ImageContent, Message } from "@earendil-works/pi-ai";
import { PiRequestError, type PiRequest, type PiOptions, type PiResult, type PiStatus } from "./pi-runtime";
import { withPiNetwork } from "./pi-network";
import { loadModelSettings } from "./pi-settings";
import type { PiImageRequest } from "./pi-runtime";
import { z } from "zod";

export async function piImageConfigured(): Promise<boolean> {
  const { runtime } = await loadModelSettings();
  return (await runtime.listCredentials()).some(item => item.providerId === "openai-codex" && item.type === "oauth");
}

export async function runPiImage(input: PiImageRequest, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(300_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return withPiNetwork(async () => {
    requestSignal.throwIfAborted();
    const { runtime } = await loadModelSettings();
    const credentials = await runtime.listCredentials();
    if (!credentials.some(item => item.providerId === "openai-codex" && item.type === "oauth")) throw new Error("请先在 AI 模型配置连接 ChatGPT 订阅（Codex）");
    const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
    if (!model) throw new Error("订阅生图所需的对话模型不可用，请检查 Pi 模型配置");
    let image: Buffer | undefined;
    const stream = runtime.streamSimple(model, { messages: [{ role: "user", timestamp: Date.now(), content: [
      { type: "text", text: input.prompt },
      ...input.images.map(url => { const comma = url.indexOf(","); return { type: "image" as const, mimeType: url.slice(5, url.indexOf(";")), data: url.slice(comma + 1) }; })
    ] }] }, {
      signal: requestSignal, transport: "sse", maxRetries: 0,
      onPayload(body) {
        const payload = body as Record<string, unknown>;
        payload.tools = [{ type: "image_generation", size: input.size, quality: input.quality, output_format: "png" }];
        payload.tool_choice = { type: "image_generation" };
      },
      onProviderStreamEvent(event) {
        const parsed = z.object({ type: z.literal("response.output_item.done"), item: z.object({
          type: z.literal("image_generation_call"), status: z.literal("completed"), result: z.string().min(1).max(56 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/)
        }) }).safeParse(event);
        if (parsed.success) image = Buffer.from(parsed.data.item.result, "base64");
      }
    });
    const result = await stream.result();
    signal?.throwIfAborted();
    if (timeout.aborted) throw new Error("订阅生图超过 5 分钟，请稍后重试");
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      const raw = result.errorMessage || "";
      if (/usage.limit|quota|429|rate.limit/i.test(raw)) throw new Error("ChatGPT 订阅生图额度不足或限流，请稍后重试或手动切换中转");
      if (/overload|503|temporarily unavailable/i.test(raw)) throw new Error("ChatGPT 生图服务器暂时过载，请稍后重试；未使用中转");
      if (/401|403|auth|token|credential/i.test(raw)) throw new Error("ChatGPT 订阅生图鉴权失败，请重新连接 ChatGPT 订阅（Codex）");
      throw new Error("ChatGPT 订阅生图失败，请检查网络、图片尺寸或参考图后重试；未使用中转");
    }
    if (!image) throw new Error("订阅没有返回完整图片，请重试；未使用中转");
    return image;
  });
}

async function loadPi(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const agentDir = getAgentDir();
  // Only terminal-saved global defaults apply; project instructions and coding tools are not loaded.
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  if (settings.drainErrors().length) throw new PiRequestError("Pi 配置文件无法读取或已损坏，请检查本机 settings.json");
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (!provider || !modelId) throw new PiRequestError("Pi 尚未保存默认模型，请在 AI 模型配置页面连接订阅并选择模型");
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), refreshOnCreate: false, signal });
  if (runtime.getError()) throw new PiRequestError("Pi 模型配置无效，请检查本机 models.json");
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new PiRequestError("Pi 默认模型不存在，请在 AI 模型配置页面重新选择并保存");
  const thinking = settings.getModelThinkingLevel(provider, modelId) || settings.getDefaultThinkingLevel() || "medium";
  return { runtime, model, thinking };
}

export async function getPiStatus(): Promise<PiStatus> {
  const { model, thinking } = await loadPi();
  return { enabled: true, configured: true, model: model.id, provider: model.provider, thinking,
    configSignature: createHash("sha256").update(JSON.stringify({ api: model.api, baseUrl: model.baseUrl })).digest("hex"),
    message: `Pi：${model.provider}/${model.id}（默认模型；登录与额度在请求时校验），原中转站兜底` };
}

export async function runPiModel(input: PiRequest, options: PiOptions = {}): Promise<PiResult> {
  return withPiNetwork(async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await runPiModelWithNetwork(input, options); }
      catch (error) {
        if (!(error instanceof PiRequestError) || error.partialText || !error.message.includes("上游服务暂时异常") || attempt >= 2) throw error;
        options.signal?.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        options.signal?.throwIfAborted();
      }
    }
  });
}

async function runPiModelWithNetwork(input: PiRequest, options: PiOptions): Promise<PiResult> {
  const { runtime, model, thinking } = await loadPi(options.signal);
  if (input.images?.length && !model.input.includes("image")) throw new PiRequestError("Pi 当前模型不支持图片输入");
  const messages: Message[] = input.messages.map(message => message.role === "assistant"
    ? { role: "assistant", content: [{ type: "text", text: message.content }], api: model.api, provider: model.provider,
        model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }
    : { role: message.role, content: message.content, timestamp: Date.now() });
  if (input.images?.length) {
    const lastUser = messages.findLast(message => message.role === "user");
    if (!lastUser || lastUser.role !== "user") throw new PiRequestError("Pi 图片请求缺少用户内容");
    const images: ImageContent[] = input.images.map(value => {
      const [header, data] = value.split(",", 2);
      return { type: "image", mimeType: header.slice(5, -7), data };
    });
    lastUser.content = [{ type: "text", text: String(lastUser.content) }, ...images];
  }
  const context: Context = { messages };
  let text = "";
  try {
    const stream = runtime.streamSimple(model, context, {
      signal: options.signal, reasoning: thinking === "off" ? undefined : thinking, maxTokens: input.maxOutputTokens,
      maxRetries: 0, transport: "sse", cacheRetention: "none"
    });
    for await (const event of stream) {
      options.signal?.throwIfAborted();
      if (event.type === "text_delta") { text += event.delta; options.onDelta?.(event.delta); }
      if (event.type === "error") throw new Error(event.error.errorMessage || "Pi 模型请求失败");
    }
    const result = await stream.result();
    if (result.stopReason !== "stop") throw new Error("Pi 模型未完整结束输出");
    text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
    if (!text.trim()) throw new Error("Pi 模型没有返回可用文字");
    return { text: text.trim(), model: result.model, provider: result.provider, wireApi: result.api,
      reasoningEffort: thinking, ok: true, fallback: false };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    // Provider errors can contain headers or tokens; expose only actionable categories.
    const raw = error instanceof Error ? error.message : "";
    const reason = /quota|usage.limit|rate.limit|429|credits|capacity|额度/i.test(raw) ? "Pi 额度不足或限流"
      : /overloaded|error occurred while processing|temporarily unavailable|503/i.test(raw) ? "Pi 上游服务暂时异常，请稍后重试"
      : /not supported when using Codex|model_not_found/i.test(raw) ? "当前 ChatGPT 账号不支持所选模型，请在 AI 模型配置切换型号"
      : /401|403|auth|credential|api.key|token|login/i.test(raw) ? "Pi 登录失效或尚未登录，请在 AI 模型配置页面重新连接订阅"
      : /complete|stop.reason|完整/i.test(raw) ? "Pi 模型输出未完整结束"
      : /timeout|timed.out/i.test(raw) ? "Pi 模型请求超时"
      : "Pi 模型连接或响应异常，请在终端检查模型和服务状态";
    throw new PiRequestError(reason, text);
  }
}
