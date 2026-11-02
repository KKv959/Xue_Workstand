import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from "undici";

export type ChatWireApi = "responses" | "chat_completions" | "auto";
export type ChatReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ChatConfigRole = "primary" | "fallback";
export type ChatTool = {
  type: "web_search";
};
export type ModelErrorKind =
  | "not_configured"
  | "auth"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "endpoint"
  | "parse"
  | "empty"
  | "unknown";

export type ChatRuntimeConfig = {
  role: ChatConfigRole;
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  responsesUrl: string;
  chatCompletionsUrl: string;
  model: string;
  wireApi: ChatWireApi;
  reasoningEffort: ChatReasoningEffort;
  chatCompletionReasoningEffort: ChatReasoningEffort;
  serviceTier: string;
  proxyUrl: string;
};

type ChatRuntimePublicTargetConfig = {
  baseUrl: string;
  model: string;
  wireApi: ChatWireApi;
  reasoningEffort: ChatReasoningEffort;
  serviceTier: string;
  responsesUrlConfigured: boolean;
  chatCompletionsUrlConfigured: boolean;
  proxyConfigured: boolean;
  configured: boolean;
};

export type ChatRuntimePublicConfig = ChatRuntimePublicTargetConfig & {
  primary: ChatRuntimePublicTargetConfig;
  fallback: ChatRuntimePublicTargetConfig;
  fallbacks: ChatRuntimePublicTargetConfig[];
  fallbackEnabled: boolean;
  fallbackConfigured: boolean;
};

export type WebResearchRuntimePublicConfig = {
  baseUrl: string;
  model: string;
  wireApi: "responses";
  reasoningEffort: ChatReasoningEffort;
  serviceTier: string;
  responsesUrlConfigured: boolean;
  proxyConfigured: boolean;
  configured: boolean;
  source: "dedicated" | "chat";
};

export type ChatProbeResult = {
  ok: boolean;
  configured: boolean;
  source: ChatConfigRole;
  model: string;
  wireApi: ChatWireApi;
  attemptedWireApi?: Exclude<ChatWireApi, "auto">;
  endpoint?: string;
  latencyMs?: number;
  checkedAt: string;
  errorKind?: ModelErrorKind;
  message?: string;
  rawError?: string;
  primaryErrorKind?: ModelErrorKind;
  primaryMessage?: string;
  primaryRawError?: string;
};

export type ModelResponseBody = { headers: { get(name: string): string | null }; text(): Promise<string> };

type FetchInitWithDispatcher = UndiciRequestInit & {
  dispatcher?: ProxyAgent;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: unknown;
};

const DEFAULT_FALLBACK_CHAT_BASE_URL = "https://www.fhl.mom";
const DEFAULT_FALLBACK_CHAT_MODEL = "gpt-5.6-sol";
const DEFAULT_WEB_RESEARCH_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_WEB_RESEARCH_MODEL = "gpt-6";
const MAX_ADDITIONAL_CHAT_FALLBACKS = 4;

class ModelRuntimeError extends Error {
  kind: ModelErrorKind;
  rawMessage?: string;

  constructor(kind: ModelErrorKind, message: string, rawMessage?: string) {
    super(message);
    this.name = "ModelRuntimeError";
    this.kind = kind;
    this.rawMessage = rawMessage;
  }
}

export class ModelHttpError extends Error {
  status: number;
  body: string;
  contentType?: string | null;

  constructor(status: number, body: string, contentType?: string | null) {
    super(describeChatHttpFailure(status, body, contentType));
    this.name = "ModelHttpError";
    this.status = status;
    this.body = body;
    this.contentType = contentType;
  }
}

export function getChatConfig() {
  const chatReasoningEffort = process.env.CHAT_REASONING_EFFORT;
  return {
    role: "primary" as const,
    enabled: process.env.CHAT_ENABLED !== "0",
    apiKey: process.env.CHAT_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: normalizeBaseUrl(process.env.CHAT_BASE_URL || process.env.OPENAI_BASE_URL || ""),
    responsesUrl: process.env.CHAT_RESPONSES_URL || "",
    chatCompletionsUrl: process.env.CHAT_COMPLETIONS_URL || "",
    model: process.env.CHAT_MODEL || process.env.OPENAI_MODEL || "",
    wireApi: normalizeWireApi(process.env.CHAT_WIRE_API || "auto"),
    reasoningEffort: normalizeReasoningEffort(chatReasoningEffort),
    chatCompletionReasoningEffort: chatReasoningEffort ? normalizeReasoningEffort(chatReasoningEffort) : "none",
    serviceTier: normalizeServiceTier(process.env.CHAT_SERVICE_TIER),
    proxyUrl: process.env.CHAT_PROXY_URL || ""
  } satisfies ChatRuntimeConfig;
}

export function getChatFallbackConfig() {
  const chatReasoningEffort = process.env.CHAT_FALLBACK_REASONING_EFFORT || process.env.CHAT_REASONING_EFFORT || "xhigh";
  return {
    role: "fallback" as const,
    enabled: process.env.CHAT_FALLBACK_ENABLED !== "0",
    apiKey: process.env.CHAT_FALLBACK_API_KEY || process.env.FHL_API_KEY || "",
    baseUrl: normalizeBaseUrl(process.env.CHAT_FALLBACK_BASE_URL || DEFAULT_FALLBACK_CHAT_BASE_URL),
    responsesUrl: process.env.CHAT_FALLBACK_RESPONSES_URL || "",
    chatCompletionsUrl: process.env.CHAT_FALLBACK_COMPLETIONS_URL || "",
    model: process.env.CHAT_FALLBACK_MODEL || DEFAULT_FALLBACK_CHAT_MODEL,
    wireApi: normalizeWireApi(process.env.CHAT_FALLBACK_WIRE_API || "responses"),
    reasoningEffort: normalizeReasoningEffort(chatReasoningEffort),
    chatCompletionReasoningEffort: chatReasoningEffort ? normalizeReasoningEffort(chatReasoningEffort) : "none",
    serviceTier: normalizeServiceTier(process.env.CHAT_FALLBACK_SERVICE_TIER),
    proxyUrl: process.env.CHAT_FALLBACK_PROXY_URL || process.env.CHAT_PROXY_URL || ""
  } satisfies ChatRuntimeConfig;
}

function getAdditionalChatFallbackConfigs() {
  return Array.from({ length: MAX_ADDITIONAL_CHAT_FALLBACKS }, (_, offset) => {
    const index = offset + 2;
    const prefix = `CHAT_FALLBACK_${index}`;
    const chatReasoningEffort =
      process.env[`${prefix}_REASONING_EFFORT`] ||
      process.env.CHAT_FALLBACK_REASONING_EFFORT ||
      process.env.CHAT_REASONING_EFFORT ||
      "xhigh";

    return {
      role: "fallback" as const,
      enabled: process.env[`${prefix}_ENABLED`] !== "0",
      apiKey: process.env[`${prefix}_API_KEY`] || "",
      baseUrl: normalizeBaseUrl(process.env[`${prefix}_BASE_URL`] || ""),
      responsesUrl: process.env[`${prefix}_RESPONSES_URL`] || "",
      chatCompletionsUrl: process.env[`${prefix}_COMPLETIONS_URL`] || "",
      model: process.env[`${prefix}_MODEL`] || "",
      wireApi: normalizeWireApi(process.env[`${prefix}_WIRE_API`] || "auto"),
      reasoningEffort: normalizeReasoningEffort(chatReasoningEffort),
      chatCompletionReasoningEffort: chatReasoningEffort ? normalizeReasoningEffort(chatReasoningEffort) : "none",
      serviceTier: normalizeServiceTier(process.env[`${prefix}_SERVICE_TIER`]),
      proxyUrl:
        process.env[`${prefix}_PROXY_URL`] ||
        process.env.CHAT_FALLBACK_PROXY_URL ||
        process.env.CHAT_PROXY_URL ||
        ""
    } satisfies ChatRuntimeConfig;
  }).filter((config) => Boolean(config.apiKey || config.baseUrl || config.model));
}

export function getChatConfigs() {
  const primary = getChatConfig();
  return [primary, getChatFallbackConfig(), ...getAdditionalChatFallbackConfigs()].filter(
    (config, index, configs) =>
      index === configs.findIndex((candidate) => sameChatRuntimeConfig(candidate, config))
  );
}

export function getConfiguredChatConfigs() {
  return getChatConfigs().filter(isChatConfigConfigured);
}

export function getWebResearchConfig() {
  return {
    role: "primary" as const,
    enabled: process.env.WEB_RESEARCH_ENABLED !== "0",
    apiKey: process.env.WEB_RESEARCH_API_KEY || "",
    baseUrl: normalizeBaseUrl(process.env.WEB_RESEARCH_BASE_URL || DEFAULT_WEB_RESEARCH_BASE_URL),
    responsesUrl: process.env.WEB_RESEARCH_RESPONSES_URL || "",
    chatCompletionsUrl: "",
    model: process.env.WEB_RESEARCH_MODEL || DEFAULT_WEB_RESEARCH_MODEL,
    wireApi: "responses" as const,
    reasoningEffort: normalizeReasoningEffort(process.env.WEB_RESEARCH_REASONING_EFFORT || "low"),
    chatCompletionReasoningEffort: "none" as const,
    serviceTier: normalizeServiceTier(process.env.WEB_RESEARCH_SERVICE_TIER),
    proxyUrl: process.env.WEB_RESEARCH_PROXY_URL || process.env.CHAT_PROXY_URL || ""
  } satisfies ChatRuntimeConfig;
}

export function isWebResearchConfigConfigured(config: ChatRuntimeConfig = getWebResearchConfig()) {
  return Boolean(config.enabled && config.apiKey && (config.baseUrl || config.responsesUrl) && config.model);
}

export function getConfiguredWebResearchConfigs() {
  const dedicated = getWebResearchConfig();
  const configs = [
    ...(isWebResearchConfigConfigured(dedicated) ? [dedicated] : []),
    ...getConfiguredChatConfigs().filter((config) =>
      config.wireApi === "responses" || Boolean(config.responsesUrl)
    )
  ];
  return configs.filter(
    (config, index) => index === configs.findIndex((candidate) => sameChatRuntimeConfig(candidate, config))
  );
}

export function getWebResearchRuntimeConfig(): WebResearchRuntimePublicConfig {
  const dedicated = getWebResearchConfig();
  const dedicatedConfigured = isWebResearchConfigConfigured(dedicated);
  const chatResponses = getConfiguredChatConfigs().find((config) =>
    config.wireApi === "responses" || Boolean(config.responsesUrl)
  );
  const active = dedicatedConfigured ? dedicated : chatResponses || dedicated;

  return {
    baseUrl: active.baseUrl,
    model: active.model,
    wireApi: "responses",
    reasoningEffort: active.reasoningEffort,
    serviceTier: active.serviceTier,
    responsesUrlConfigured: Boolean(active.responsesUrl),
    proxyConfigured: Boolean(active.proxyUrl),
    configured: Boolean(dedicatedConfigured || chatResponses),
    source: dedicatedConfigured ? "dedicated" : "chat"
  };
}

export function isChatConfigConfigured(config: ChatRuntimeConfig) {
  return Boolean(
    config.enabled &&
    config.apiKey &&
    config.model &&
    hasConfiguredChatEndpoint(config)
  );
}

function hasConfiguredChatEndpoint(config: ChatRuntimeConfig) {
  if (config.wireApi === "responses") return Boolean(config.responsesUrl || config.baseUrl);
  if (config.wireApi === "chat_completions") return Boolean(config.chatCompletionsUrl || config.baseUrl);
  return Boolean(config.responsesUrl || config.chatCompletionsUrl || config.baseUrl);
}

export function getChatRuntimeConfig(): ChatRuntimePublicConfig {
  const primary = getChatConfig();
  const fallback = getChatFallbackConfig();
  const fallbacks = [fallback, ...getAdditionalChatFallbackConfigs()];
  const publicPrimary = toPublicChatConfig(primary);
  const publicFallbacks = fallbacks.map(toPublicChatConfig);
  const publicFallback = publicFallbacks[0];
  const active = [publicPrimary, ...publicFallbacks].find((config) => config.configured) || publicPrimary;

  return {
    ...active,
    configured: [publicPrimary, ...publicFallbacks].some((config) => config.configured),
    primary: publicPrimary,
    fallback: publicFallback,
    fallbacks: publicFallbacks,
    fallbackEnabled: fallbacks.some((config) => config.enabled),
    fallbackConfigured: publicFallbacks.some((config) => config.configured)
  };
}

export async function postModelRequest(
  config: ChatRuntimeConfig,
  pathName: "/responses" | "/chat/completions",
  payload: unknown,
  signal?: AbortSignal
) {
  const init: FetchInitWithDispatcher = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    dispatcher: chatDispatcher(config.proxyUrl),
    signal
  };
  const response = await undiciFetch(modelEndpoint(config, pathName), init);
  if (!response.ok) {
    throw new ModelHttpError(response.status, await response.text(), response.headers.get("content-type"));
  }
  return response;
}

export function modelEndpoint(config: ChatRuntimeConfig, pathName: "/responses" | "/chat/completions") {
  const configured = pathName === "/responses" ? config.responsesUrl : config.chatCompletionsUrl;
  if (configured) return configured;

  if (config.baseUrl.endsWith(pathName)) {
    return config.baseUrl;
  }
  if (config.baseUrl.endsWith("/responses")) {
    return `${config.baseUrl.slice(0, -"/responses".length)}${pathName}`;
  }
  if (config.baseUrl.endsWith("/chat/completions")) {
    return `${config.baseUrl.slice(0, -"/chat/completions".length)}${pathName}`;
  }

  return `${config.baseUrl}${pathName}`;
}

function toPublicChatConfig(config: ChatRuntimeConfig): ChatRuntimePublicTargetConfig {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    wireApi: config.wireApi,
    reasoningEffort: config.reasoningEffort,
    serviceTier: config.serviceTier,
    responsesUrlConfigured: Boolean(config.responsesUrl),
    chatCompletionsUrlConfigured: Boolean(config.chatCompletionsUrl),
    proxyConfigured: Boolean(config.proxyUrl),
    configured: isChatConfigConfigured(config)
  };
}

function sameChatRuntimeConfig(first: ChatRuntimeConfig, second: ChatRuntimeConfig) {
  return (
    first.enabled === second.enabled &&
    first.apiKey === second.apiKey &&
    first.baseUrl === second.baseUrl &&
    first.responsesUrl === second.responsesUrl &&
    first.chatCompletionsUrl === second.chatCompletionsUrl &&
    first.model === second.model &&
    first.wireApi === second.wireApi &&
    first.reasoningEffort === second.reasoningEffort &&
    first.chatCompletionReasoningEffort === second.chatCompletionReasoningEffort &&
    first.serviceTier === second.serviceTier &&
    first.proxyUrl === second.proxyUrl
  );
}

export function responseReasoning(effort: ChatReasoningEffort) {
  return effort === "none" ? undefined : { effort };
}

export function chatCompletionPayload(input: {
  config: ChatRuntimeConfig;
  messages: ChatMessage[];
  reasoningEffort?: ChatReasoningEffort;
  maxOutputTokens?: number;
  stream: boolean;
  webSearch?: boolean;
}) {
  const effort = input.reasoningEffort || input.config.chatCompletionReasoningEffort;
  return {
    model: input.config.model,
    messages: input.messages,
    ...(/^gpt-6(?:\.\d+)?(?:-|$)/i.test(input.config.model) ? {} : { temperature: 0.75 }),
    stream: input.stream,
    max_tokens: input.maxOutputTokens,
    ...(input.webSearch ? { web_search_options: {} } : {}),
    ...(input.config.serviceTier ? { service_tier: input.config.serviceTier } : {}),
    ...(effort === "none" ? {} : { reasoning_effort: effort })
  };
}

export async function probeChatModel(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ChatProbeResult> {
  const configs = getChatConfigs();
  const configuredConfigs = configs.filter(isChatConfigConfigured);
  const fallbackConfig = getChatFallbackConfig();
  const checkedAt = new Date().toISOString();
  if (!configuredConfigs.length) {
    return {
      ok: false,
      configured: false,
      source: "primary",
      model: getChatConfig().model || fallbackConfig.model,
      wireApi: getChatConfig().wireApi,
      checkedAt,
      errorKind: "not_configured",
      message: "未配置对话模型。"
    };
  }

  const startedAt = Date.now();
  let primaryFailure: ReturnType<typeof classifyModelFailure> | undefined;
  let lastFailure: ReturnType<typeof classifyModelFailure> | undefined;
  let lastConfig = configuredConfigs[0];

  for (const config of configuredConfigs) {
    lastConfig = config;
    try {
      const result = await withProbeTimeout(
        (signal) => probeConfiguredChatModel(config, signal),
        options.timeoutMs ?? modelProbeTimeoutMs(),
        options.signal
      );
      return {
        ...result,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        ...(primaryFailure
          ? {
              message: `主模型${primaryFailure.userMessage}，已切换到备用模型。`,
              primaryErrorKind: primaryFailure.kind,
              primaryMessage: primaryFailure.userMessage,
              primaryRawError: primaryFailure.rawMessage
            }
          : {})
      };
    } catch (error) {
      throwIfAborted(options.signal);
      const failure = classifyModelFailure(error);
      lastFailure = failure;
      if (config.role === "primary") primaryFailure = failure;
    }
  }

  if (lastFailure) {
    return {
      ok: false,
      configured: true,
      source: lastConfig.role,
      model: lastConfig.model,
      wireApi: lastConfig.wireApi,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      errorKind: lastFailure.kind,
      message: lastFailure.userMessage,
      rawError: lastFailure.rawMessage,
      ...(primaryFailure
        ? {
            primaryErrorKind: primaryFailure.kind,
            primaryMessage: primaryFailure.userMessage,
            primaryRawError: primaryFailure.rawMessage
          }
        : {})
    };
  }

  return {
    ok: false,
    configured: false,
    source: "primary",
    model: getChatConfig().model || fallbackConfig.model,
    wireApi: getChatConfig().wireApi,
    checkedAt,
    latencyMs: Date.now() - startedAt,
    errorKind: "not_configured",
    message: "未配置对话模型。"
  };
}

export function shouldRetryResponsesAsChatCompletions(error: unknown) {
  if (!(error instanceof ModelHttpError)) return false;
  const detail = `${error.status} ${error.body}`.toLowerCase();
  return (
    error.status === 404 ||
    error.status === 405 ||
    /responses|response api|unknown endpoint|not found|unsupported|invalid url|no route|cannot post/.test(detail)
  );
}

export function buildChatFallbackReason(error: unknown) {
  return `${summarizeChatFailure(error)}，已自动切换到本地模板，可先编辑后再重试。`;
}

export function summarizeChatFailure(error: unknown) {
  return classifyModelFailure(error).userMessage;
}

export function classifyModelFailure(error: unknown): {
  kind: ModelErrorKind;
  userMessage: string;
  rawMessage: string;
} {
  // A wrapper may mention a failed primary provider. Classify the actual final
  // transport error instead of mistaking that earlier provider's quota for it.
  const visited = new Set<unknown>();
  let nested: unknown = error;
  while (nested && typeof nested === "object" && !visited.has(nested)) {
    visited.add(nested);
    if (nested !== error && (nested instanceof ModelHttpError || nested instanceof ModelRuntimeError)) {
      return classifyModelFailure(nested);
    }
    nested = ("originalError" in nested && nested.originalError) || ("cause" in nested && nested.cause);
  }
  if (error instanceof ModelRuntimeError) {
    return {
      kind: error.kind,
      userMessage: error.message,
      rawMessage: error.rawMessage || error.message
    };
  }

  const originalError = unwrapOriginalError(error);
  const cause = originalError instanceof Error ? originalError.cause : undefined;
  const causeMessage =
    cause instanceof Error
      ? `${cause.name} ${cause.message} ${(cause as { code?: string }).code || ""}`
      : "";
  const message = [
    error instanceof Error ? error.name : "",
    error instanceof Error ? error.message : String(error || ""),
    originalError instanceof Error ? originalError.message : String(originalError || ""),
    causeMessage
  ].join(" ");

  if (/524\b|超时|a timeout occurred|timeout|timed out|AbortError|TimeoutError|aborted|UND_ERR_HEADERS_TIMEOUT/i.test(message)) {
    return { kind: "timeout", userMessage: "对话模型服务超时", rawMessage: compactErrorMessage(message) };
  }
  if (/402\b|insufficient[_\s-]*(?:user[_\s-]*)?quota|insufficient[_\s-]*balance|quota[_\s-]*exceeded|billing|payment[_\s-]*required|credit|余额|额度|预扣费|扣费/i.test(message)) {
    return { kind: "quota", userMessage: "对话模型服务额度不足", rawMessage: compactErrorMessage(message) };
  }
  if (/429\b|rate limit/i.test(message)) {
    return { kind: "rate_limit", userMessage: "对话模型服务限流", rawMessage: compactErrorMessage(message) };
  }
  if (/401\b|403\b|unauthorized|forbidden/i.test(message)) {
    return { kind: "auth", userMessage: "对话模型服务鉴权异常", rawMessage: compactErrorMessage(message) };
  }
  if (/模型连接中断，未收到完成结果|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|other side closed|fetch failed|SocketError/i.test(message)) {
    return { kind: "network", userMessage: "对话模型服务连接异常", rawMessage: compactErrorMessage(message) };
  }
  if (/No available channel for model/i.test(message)) {
    return { kind: "endpoint", userMessage: "中转站当前分组没有该模型的可用渠道，请检查 API Key 分组和模型渠道，或切换已验证可用的模型", rawMessage: compactErrorMessage(message) };
  }
  if (/\bmodel_not_found\b/i.test(message)) {
    return { kind: "endpoint", userMessage: "当前节点不支持所选模型，请检查中转站模型配置，或切换已配置的中转模型", rawMessage: compactErrorMessage(message) };
  }
  if (originalError instanceof ModelHttpError && (originalError.status === 400 || originalError.status === 422)) {
    return { kind: "endpoint", userMessage: "对话模型请求参数或模型配置不兼容，请检查节点配置", rawMessage: compactErrorMessage(message) };
  }
  if (/404\b|405\b|unknown endpoint|not found|unsupported|invalid url|no route|cannot post/i.test(message)) {
    return { kind: "endpoint", userMessage: "对话模型接口地址不兼容", rawMessage: compactErrorMessage(message) };
  }
  if (/无法解析|parse|JSON/i.test(message)) {
    return { kind: "parse", userMessage: "对话模型返回格式异常", rawMessage: compactErrorMessage(message) };
  }
  if (/empty|没有返回|未返回|空/i.test(message)) {
    return { kind: "empty", userMessage: "对话模型没有返回可用内容", rawMessage: compactErrorMessage(message) };
  }
  if (/上游服务过载|servers are currently overloaded/i.test(message)) {
    return { kind: "server", userMessage: "对话模型上游服务过载，请稍后重试", rawMessage: compactErrorMessage(message) };
  }
  if (/5\d\d\b|对话模型调用失败：/i.test(message)) {
    return { kind: "server", userMessage: "对话模型服务暂时异常", rawMessage: compactErrorMessage(message) };
  }
  return { kind: "unknown", userMessage: "对话模型暂时不可用", rawMessage: compactErrorMessage(message) };
}

export function summarizeChatErrorBody(body: string, contentType?: string | null) {
  const trimmed = body.trim();
  if (!trimmed) return "";

  const isHtml = Boolean(contentType?.includes("text/html")) || /^<!doctype html\b/i.test(trimmed) || /^<html\b/i.test(trimmed);
  if (isHtml) {
    if (/error code 524|a timeout occurred/i.test(trimmed)) {
      return "模型服务响应超时";
    }

    const title = trimmed.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    return title ? `服务返回 HTML 错误页（${title}）` : "服务返回 HTML 错误页";
  }

  return trimmed.replace(/\s+/g, " ").slice(0, 240);
}

function normalizeWireApi(value?: string): ChatWireApi {
  if (value === "chat_completions" || value === "chat-completions" || value === "chat") return "chat_completions";
  if (value === "auto") return "auto";
  return "responses";
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function normalizeReasoningEffort(value?: string): ChatReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "xhigh";
}

function normalizeServiceTier(value?: string) {
  return (value || "").trim();
}

// Share pools across model calls and Next development module reloads. Keys may
// contain proxy credentials and must never be logged.
const modelTransportGlobal = globalThis as typeof globalThis & {
  modelProxyDispatchers?: Map<string, ProxyAgent>;
};
const proxyDispatchers = modelTransportGlobal.modelProxyDispatchers ??= new Map<string, ProxyAgent>();
const MAX_PROXY_DISPATCHERS = 8;

export function chatDispatcher(proxyUrl: string): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;
  const cached = proxyDispatchers.get(proxyUrl);
  if (cached) {
    proxyDispatchers.delete(proxyUrl);
    proxyDispatchers.set(proxyUrl, cached);
    return cached;
  }
  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    // Keep idle tunnels between preparation and generation; upstream keep-alive
    // hints still take precedence. Do not limit concurrent generation here.
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000
  });
  proxyDispatchers.set(proxyUrl, dispatcher);
  if (proxyDispatchers.size > MAX_PROXY_DISPATCHERS) {
    const oldestKey = proxyDispatchers.keys().next().value!;
    const oldest = proxyDispatchers.get(oldestKey)!;
    proxyDispatchers.delete(oldestKey);
    // Graceful close drains in-flight requests when proxy configurations rotate.
    void oldest.close().catch(() => {
      // Cleanup failure must not replace a generation result or expose credentials.
      console.warn("模型旧代理连接池关闭失败，请重启服务释放连接。");
    });
  }
  return dispatcher;
}

function describeChatHttpFailure(status: number, body: string, contentType?: string | null) {
  const detail = summarizeChatErrorBody(body, contentType);
  return `对话模型调用失败：${status}${detail ? ` ${detail}` : ""}`;
}

async function probeConfiguredChatModel(config: ChatRuntimeConfig, signal: AbortSignal): Promise<ChatProbeResult> {
  if (config.wireApi === "chat_completions") {
    return probeChatCompletions(config, signal);
  }

  try {
    return await probeResponses(config, signal);
  } catch (error) {
    if (config.wireApi === "auto" || shouldRetryResponsesAsChatCompletions(error)) {
      return probeChatCompletions(config, signal);
    }
    throw error;
  }
}

async function probeResponses(config: ChatRuntimeConfig, signal: AbortSignal): Promise<ChatProbeResult> {
  const response = await postModelRequest(config, "/responses", {
    model: config.model,
    instructions: "你是健康检查探针。只回复 ok。",
    input: [{ role: "user", content: "请只回复 ok" }],
    stream: /^gpt-6(?:\.\d+)?(?:-|$)/i.test(config.model),
    max_output_tokens: /^gpt-6(?:\.\d+)?(?:-|$)/i.test(config.model) ? 256 : 16,
    reasoning: responseReasoning(/^gpt-6(?:\.\d+)?(?:-|$)/i.test(config.model) ? "low" : "none"),
    store: false
  }, signal);
  const text = await parseResponseApiBody(response);
  if (!text.trim()) {
    throw new ModelRuntimeError("empty", "对话模型探针没有返回可用内容。");
  }
  return {
    ok: true,
    configured: true,
    source: config.role,
    model: config.model,
    wireApi: config.wireApi,
    attemptedWireApi: "responses",
    endpoint: modelEndpoint(config, "/responses"),
    checkedAt: new Date().toISOString()
  };
}

async function probeChatCompletions(config: ChatRuntimeConfig, signal: AbortSignal): Promise<ChatProbeResult> {
  const response = await postModelRequest(config, "/chat/completions", chatCompletionPayload({
    config,
    messages: [
      { role: "system", content: "你是健康检查探针。只回复 ok。" },
      { role: "user", content: "请只回复 ok" }
    ],
    reasoningEffort: /^gpt-6(?:\.\d+)?(?:-|$)/i.test(config.model) ? "low" : "none",
    maxOutputTokens: /^gpt-6(?:\.\d+)?(?:-|$)/i.test(config.model) ? 256 : 16,
    // 健康探针只需要验证可生成文本。部分 OpenAI 兼容网关会把流式探针路由到网页入口，
    // 与实际评论生成使用的非流式调用不一致，因而固定使用非流式请求。
    stream: false
  }), signal);
  const text = await parseChatCompletionResponseBody(response);
  if (!text.trim()) {
    throw new ModelRuntimeError("empty", "对话模型探针没有返回可用内容。");
  }
  return {
    ok: true,
    configured: true,
    source: config.role,
    model: config.model,
    wireApi: config.wireApi,
    attemptedWireApi: "chat_completions",
    endpoint: modelEndpoint(config, "/chat/completions"),
    checkedAt: new Date().toISOString()
  };
}

async function withProbeTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    if (controller.signal.aborted) {
      throw new ModelRuntimeError("timeout", `对话模型健康检查超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    parentSignal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }
}

function modelProbeTimeoutMs() {
  const parsed = Number.parseInt(process.env.CHAT_HEALTH_PROBE_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed)) return 8_000;
  return Math.min(Math.max(parsed, 2_000), 30_000);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("任务已停止");
  error.name = "AbortError";
  throw error;
}

async function parseResponseApiBody(response: ModelResponseBody) {
  const contentType = response.headers.get("content-type");
  const body = await response.text();

  if (contentType?.includes("text/event-stream") || looksLikeEventStreamBody(body)) {
    return parseResponseEventStream(body);
  }

  return extractResponseText(parseModelJsonBody(body, contentType));
}

async function parseChatCompletionResponseBody(response: ModelResponseBody) {
  const contentType = response.headers.get("content-type");
  const body = await response.text();

  if (contentType?.includes("text/event-stream") || looksLikeEventStreamBody(body)) {
    return parseChatCompletionEventStream(body);
  }

  return extractChatCompletionText(parseModelJsonBody(body, contentType));
}

function parseResponseEventStream(body: string) {
  let aggregatedText = "";

  for (const rawEvent of body.split("\n\n")) {
    const lines = rawEvent
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s*/, ""));

    for (const payload of dataLines) {
      if (!payload || payload === "[DONE]") continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
        aggregatedText += parsed.delta;
      } else if (
        parsed.type === "response.output_text.done" ||
        parsed.type === "response.content_part.done" ||
        parsed.type === "response.output_item.done"
      ) {
        aggregatedText = mergeResponseText(aggregatedText, extractResponseText(parsed));
      } else if (parsed.type === "response.completed") {
        aggregatedText = mergeResponseText(aggregatedText, extractResponseText(parsed.response));
      } else if (parsed.type === "response.failed" || parsed.type === "response.incomplete") {
        const errorMessage =
          extractResponseErrorMessage(parsed.response) || extractResponseErrorMessage(parsed) || "模型输出失败";
        throw new Error(errorMessage);
      }
    }
  }

  return aggregatedText.trim();
}

function parseChatCompletionEventStream(body: string) {
  let aggregatedText = "";

  for (const rawEvent of body.split("\n\n")) {
    const delta = parseChatCompletionStreamDelta(rawEvent);
    if (delta) aggregatedText += delta;
  }

  return aggregatedText.trim();
}

function looksLikeEventStreamBody(body: string) {
  const trimmed = body.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}

function parseModelJsonBody(body: string, contentType?: string | null) {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const detail = summarizeChatErrorBody(body, contentType);
    throw new ModelRuntimeError(
      "parse",
      detail ? `模型服务返回了无法解析的内容：${detail}` : "模型服务返回了无法解析的内容",
      body
    );
  }
}

function extractResponseText(data: unknown): string {
  return extractResponseTextValue(data).trim();
}

function extractResponseTextValue(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const object = data as Record<string, unknown>;

  if (typeof object.output_text === "string") return object.output_text;
  if (typeof object.text === "string") return object.text;
  if (object.response) return extractResponseTextValue(object.response);
  if (object.item) return extractResponseTextValue(object.item);
  if (object.part) return extractResponseTextValue(object.part);
  if (Array.isArray(object.content)) return extractResponseContentText(object.content);
  if (!Array.isArray(object.output)) return "";

  return object.output
    .map((item) => extractResponseTextValue(item))
    .filter(Boolean)
    .join("\n");
}

function extractResponseContentText(content: unknown[]) {
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      return extractResponseTextValue(item);
    })
    .filter(Boolean)
    .join("\n");
}

function mergeResponseText(current: string, candidate: string) {
  if (!candidate.trim()) return current;
  if (!current) return candidate;
  if (candidate === current || current.startsWith(candidate)) return current;
  if (candidate.startsWith(current)) return candidate;
  return candidate.length > current.length ? candidate : current;
}

function extractResponseErrorMessage(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const object = data as Record<string, unknown>;
  const error = object.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const errorObject = error as Record<string, unknown>;
    return [errorObject.message, errorObject.code, errorObject.type]
      .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
      .join(" ");
  }
  return "";
}

function parseChatCompletionStreamDelta(rawEvent: string) {
  const lines = rawEvent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s*/, ""));

  for (const payload of dataLines) {
    if (!payload || payload === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    const delta = extractChatCompletionDelta(parsed);
    if (delta) return delta;
  }

  return "";
}

function extractChatCompletionDelta(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const object = data as Record<string, unknown>;
  const choices = Array.isArray(object.choices) ? object.choices : [];
  return choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const choiceObject = choice as Record<string, unknown>;
      const delta = choiceObject.delta && typeof choiceObject.delta === "object"
        ? (choiceObject.delta as Record<string, unknown>)
        : {};
      const message = choiceObject.message && typeof choiceObject.message === "object"
        ? (choiceObject.message as Record<string, unknown>)
        : {};
      return stringFromChatContent(delta.content) || stringFromChatContent(message.content) || "";
    })
    .filter(Boolean)
    .join("");
}

function extractChatCompletionText(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const object = data as Record<string, unknown>;
  const choices = Array.isArray(object.choices) ? object.choices : [];

  return choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const choiceObject = choice as Record<string, unknown>;
      const message = choiceObject.message && typeof choiceObject.message === "object"
        ? (choiceObject.message as Record<string, unknown>)
        : {};
      return stringFromChatContent(message.content) || extractChatCompletionDelta(choiceObject);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stringFromChatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const object = part as Record<string, unknown>;
      return typeof object.text === "string" ? object.text : "";
    })
    .join("");
}

function unwrapOriginalError(error: unknown) {
  if (!error || typeof error !== "object" || !("originalError" in error)) return error;
  return (error as { originalError?: unknown }).originalError || error;
}

function compactErrorMessage(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 320);
}
