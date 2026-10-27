import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { promises as dns } from "dns";
import { isIP } from "net";
import { promisify } from "util";
import { extractFeishuSupportDocumentRefs, fetchFeishuSupportDocuments, hasFeishuDocLink } from "./feishu";
import { runOpenCli } from "./opencli-runtime";
import { extractLinksFromInput } from "./platform-links";
import { readSupportDocumentCache, writeSupportDocumentCache } from "./storage/support-documents";
import { clampText } from "./utils";

const execFileAsync = promisify(execFile);
const MAX_SUPPORT_DOCUMENTS = 4;
const MAX_DOCUMENT_CHARS = 8_000;
const WECOM_POLL_ATTEMPTS = 12;
const REMOTE_FETCH_TIMEOUT_MS = 30_000;

export type SupportDocumentProvider = "feishu" | "lingxi" | "wecom" | "tencent-docs" | "web";

export type FetchedSupportDocument = {
  url: string;
  provider: SupportDocumentProvider;
  title?: string;
  content?: string;
  error?: string;
};

type FetchSupportDocumentOptions = {
  signal?: AbortSignal;
};

export type WecomDocumentResponse = {
  errcode?: number;
  errmsg?: string;
  task_id?: string;
  task_done?: boolean;
  content?: string;
};

export function hasSupportDocumentReference(input?: string) {
  const text = input?.trim() || "";
  return Boolean(text && (hasFeishuDocLink(text) || extractLinksFromInput(text).length));
}

export function hasPlainSupportText(input: string) {
  const withoutRefs = input
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com|feishu-boe\.cn)\/\S+/gi, " ")
    .replace(/\b(?:docxcn|doxcn|doccn|wikcn)[A-Za-z0-9_-]{8,}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return withoutRefs.length >= 80;
}

export async function fetchSupportDocuments(
  input: string,
  options: FetchSupportDocumentOptions = {}
): Promise<FetchedSupportDocument[]> {
  throwIfAborted(options.signal);
  const urls = uniqueHttpUrls(input);
  const references = urls.length ? urls : hasFeishuDocLink(input) ? extractFeishuSupportDocumentRefs(input) : [];
  if (references.length > MAX_SUPPORT_DOCUMENTS) {
    throw Object.assign(new Error(`一次最多读取 ${MAX_SUPPORT_DOCUMENTS} 份支持文档，当前有 ${references.length} 份，请减少链接后重试。`), { statusCode: 400 });
  }
  const documents: FetchedSupportDocument[] = [];

  for (const url of references) {
    throwIfAborted(options.signal);
    documents.push(await fetchSupportDocument(url, options));
  }

  return documents;
}

export function supportDocumentProviderLabel(provider: SupportDocumentProvider) {
  switch (provider) {
    case "feishu":
      return "飞书文档";
    case "lingxi":
      return "网易灵犀文档";
    case "wecom":
      return "企业微信文档";
    case "tencent-docs":
      return "腾讯文档";
    default:
      return "公开网页资料";
  }
}

async function fetchSupportDocument(
  url: string,
  options: FetchSupportDocumentOptions
): Promise<FetchedSupportDocument> {
  const provider = detectSupportDocumentProvider(url);

  try {
    const cached = await readSupportDocumentCache(url);
    if (cached) {
      return {
        url,
        provider: cached.provider,
        title: cached.title,
        content: cached.content
      };
    }

    const document = await fetchSupportDocumentFresh(url, provider, options);
    if (document.content?.trim()) {
      await writeSupportDocumentCache({
        url,
        provider: document.provider,
        title: document.title,
        content: document.content
      });
    }
    return document;
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    return {
      url,
      provider,
      error: summarizeSupportDocumentError(error, provider)
    };
  }
}

async function fetchSupportDocumentFresh(
  url: string,
  provider: SupportDocumentProvider,
  options: FetchSupportDocumentOptions
): Promise<FetchedSupportDocument> {
  if (provider === "feishu") {
    const document = (await fetchFeishuSupportDocuments(url, options))[0];
    return document
      ? { ...document, provider }
      : { url, provider, error: "没有识别到可读取的飞书文档" };
  }
  if (provider === "lingxi") return fetchLingxiDocument(url, options);
  if (provider === "wecom") return fetchWecomDocument(url, options);
  return fetchPublicWebDocument(url, provider, options);
}

function detectSupportDocumentProvider(url: string): SupportDocumentProvider {
  if (!/^https?:\/\//i.test(url) && hasFeishuDocLink(url)) return "feishu";
  const host = new URL(url).hostname.toLowerCase();
  if (matchesHost(host, "feishu.cn") || matchesHost(host, "larksuite.com") || matchesHost(host, "feishu-boe.cn")) {
    return "feishu";
  }
  if (matchesHost(host, "docs.popo.netease.com")) return "lingxi";
  if (matchesHost(host, "doc.weixin.qq.com")) return "wecom";
  if (matchesHost(host, "docs.qq.com")) return "tencent-docs";
  return "web";
}

async function fetchLingxiDocument(
  url: string,
  options: FetchSupportDocumentOptions
): Promise<FetchedSupportDocument> {
  const parsedUrl = new URL(url);
  const identity = parsedUrl.pathname.match(/\/lingxi\/([A-Za-z0-9_-]+)/i)?.[1] || "";
  if (!identity) throw new Error("灵犀链接中没有识别到文档 ID");

  const docsOrigin = "https://docs.popo.netease.com";
  const officeOrigin = "https://office.netease.com";
  const referer = `${docsOrigin}/lingxi/${encodeURIComponent(identity)}`;
  const jar = new MemoryCookieJar();

  const accessPayload = await fetchWithCookieJar(
    `${docsOrigin}/api/bs-doc/v1/access/url`,
    jar,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemType: 0, itemId: identity })
    },
    { ...options, referer },
    (response) => readJsonObject(response, "灵犀访客授权失败")
  );
  assertLingxiSuccess(accessPayload, "灵犀访客授权失败");

  const metadata = await fetchWithCookieJar(
    `${docsOrigin}/api/bs-doc/v1/document/get/${encodeURIComponent(identity)}?share_token=`,
    jar,
    {},
    { ...options, referer },
    (response) => readJsonObject(response, "灵犀文档信息读取失败")
  );
  assertLingxiSuccess(metadata, "灵犀文档信息读取失败");
  const metadataData = asObject(metadata.data);
  const title = stringValue(metadataData.name || metadataData.title);

  const traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
  const additionalParam = new URLSearchParams({
    identity,
    defaultTheme: "light",
    from: "POPO_DOC",
    traceparent,
    fragment: ""
  }).toString();
  const loginPayload = await fetchWithCookieJar(
    `${docsOrigin}/api/bs-user/v1/disposable/login/third?type=lingxi_doc&additionalParam=${encodeURIComponent(additionalParam)}`,
    jar,
    {},
    { ...options, referer },
    (response) => readJsonObject(response, "灵犀正文访问票据获取失败")
  );
  assertLingxiSuccess(loginPayload, "灵犀正文访问票据获取失败");
  const loginUrl = stringValue(asObject(loginPayload.data).url);
  if (!loginUrl || new URL(loginUrl).hostname.toLowerCase() !== "office.netease.com") {
    throw new Error("灵犀没有返回有效的正文访问地址");
  }

  await fetchWithCookieJar(
    loginUrl,
    jar,
    { headers: { accept: "text/html,application/xhtml+xml" } },
    { ...options, referer },
    async (response) => { await response.body?.cancel(); }
  );
  if (!jar.hasCookieForHost("office.netease.com")) {
    throw new Error("灵犀访客会话建立失败");
  }

  const latestPayload = await fetchWithCookieJar(
    `${officeOrigin}/api/admin/cowork/view-doc-latest-history?identity=${encodeURIComponent(identity)}&docType=doc&serverType=GEZHI`,
    jar,
    {},
    { ...options, referer: `${officeOrigin}/doc/?identity=${encodeURIComponent(identity)}` },
    (response) => readJsonObject(response, "灵犀正文读取失败")
  );
  const latestData = asObject(latestPayload.data);
  if (Number(latestPayload.code) !== 0 || typeof latestData.content !== "string") {
    throw new Error(stringValue(latestPayload.message) || "灵犀没有返回可用正文");
  }

  const content = extractLingxiText(latestData.content);
  if (!content) throw new Error("灵犀文档正文为空，或当前链接没有正文查看权限");
  return {
    url,
    provider: "lingxi",
    title,
    content: clampText(content, MAX_DOCUMENT_CHARS)
  };
}

async function fetchWecomDocument(
  url: string,
  options: FetchSupportDocumentOptions
): Promise<FetchedSupportDocument> {
  let content = "";
  let normalDocumentError: unknown;

  try {
    content = await pollWecomDocumentContent(url, options);
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    normalDocumentError = error;
  }

  if (!content) {
    try {
      content = await pollWecomSmartPageContent(url, options);
    } catch (smartPageError) {
      if (isAbortError(smartPageError, options.signal)) throw smartPageError;
      throw new Error([
        normalDocumentError instanceof Error ? normalDocumentError.message : "普通文档读取失败",
        smartPageError instanceof Error ? smartPageError.message : "智能文档读取失败"
      ].join("；"));
    }
  }

  if (!content.trim()) throw new Error("wecom-cli 没有返回可用正文");
  return {
    url,
    provider: "wecom",
    title: extractMarkdownTitle(content),
    content: clampText(content.trim(), MAX_DOCUMENT_CHARS)
  };
}

async function pollWecomDocumentContent(url: string, options: FetchSupportDocumentOptions) {
  let response = await callWecomDocumentCommand("get_doc_content", { url, type: 2 }, options);
  for (let attempt = 0; attempt < WECOM_POLL_ATTEMPTS && !response.task_done; attempt += 1) {
    if (!response.task_id) throw new Error("企业微信文档读取任务缺少 task_id");
    await waitWithSignal(250, options.signal);
    response = await callWecomDocumentCommand("get_doc_content", {
      url,
      type: 2,
      task_id: response.task_id
    }, options);
  }
  if (!response.task_done || typeof response.content !== "string") {
    throw new Error("企业微信文档读取超时");
  }
  return response.content;
}

async function pollWecomSmartPageContent(url: string, options: FetchSupportDocumentOptions) {
  const start = await callWecomDocumentCommand("smartpage_export_task", { url, content_type: 1 }, options);
  if (!start.task_id) throw new Error("企业微信智能文档导出任务缺少 task_id");

  let response: WecomDocumentResponse = start;
  for (let attempt = 0; attempt < WECOM_POLL_ATTEMPTS && !response.task_done; attempt += 1) {
    await waitWithSignal(250, options.signal);
    response = await callWecomDocumentCommand("smartpage_get_export_result", { task_id: start.task_id }, options);
  }
  if (!response.task_done || typeof response.content !== "string") {
    throw new Error("企业微信智能文档导出超时");
  }
  return response.content;
}

async function callWecomDocumentCommand(
  method: string,
  input: Record<string, unknown>,
  options: FetchSupportDocumentOptions
): Promise<WecomDocumentResponse> {
  throwIfAborted(options.signal);
  return callLocalWecomDocumentCommand(method, input, options);
}

export async function callLocalWecomDocumentCommand(
  method: string,
  input: Record<string, unknown>,
  options: FetchSupportDocumentOptions = {}
): Promise<WecomDocumentResponse> {
  const command = process.env.WECOM_CLI_BIN?.trim() || "wecom-cli";
  let stdout = "";
  try {
    const result = await execFileAsync(command, ["doc", method, "--json", JSON.stringify(input)], {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000,
      signal: options.signal
    });
    stdout = result.stdout;
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    if (isMissingExecutable(error)) throw new Error("未检测到 wecom-cli，请先安装并运行 wecom-cli init");
    throw new Error(formatExternalCommandError(error, "wecom-cli 执行失败"));
  }

  const outer = parseJson(stdout);
  const resultText = findCliTextResult(outer);
  const response = asObject(parseJson(resultText || stdout)) as WecomDocumentResponse;
  if (response.errcode && response.errcode !== 0) {
    throw new Error(response.errmsg || `企业微信接口错误 ${response.errcode}`);
  }
  if (!Object.keys(response).length) throw new Error("wecom-cli 返回了无法解析的文档响应");
  return response;
}

async function fetchPublicWebDocument(
  url: string,
  provider: "tencent-docs" | "web",
  options: FetchSupportDocumentOptions
): Promise<FetchedSupportDocument> {
  if (provider === "web") await assertPublicRemoteUrl(url);
  const stdout = await runOpenCli([
    "web",
    "read",
    "--url",
    url,
    "--stdout",
    "true",
    "--download-images",
    "false",
    "--wait",
    provider === "tencent-docs" ? "5" : "3",
    "-f",
    "json"
  ], {
    signal: options.signal,
    timeout: 75_000,
    timingStage: "support-document-opencli"
  });
  const content = normalizeOpenCliDocument(stdout, url);
  if (!content) throw new Error("opencli 没有读取到可用正文，链接可能未公开或需要登录");
  return {
    url,
    provider,
    title: extractMarkdownTitle(content),
    content: clampText(content, MAX_DOCUMENT_CHARS)
  };
}

function normalizeOpenCliDocument(stdout: string, url: string) {
  const trimmed = stdout.trim();
  if (!trimmed || /^ok:\s*false\b/im.test(trimmed)) return "";
  const withoutSourceHeader = trimmed
    .replace(new RegExp(`^>\\s*原文链接:\\s*${escapeRegExp(url)}\\s*$`, "gim"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (withoutSourceHeader.length < 40) return "";
  if (withoutSourceHeader.length < 600 && /(?:登录后|登录以|需要权限|申请权限|access denied|requires permission)/i.test(withoutSourceHeader)) {
    return "";
  }
  return withoutSourceHeader;
}

function extractLingxiText(serializedContent: string) {
  const root = asObject(parseJson(serializedContent));
  const leaves = findArrayByKey(root, "leaves");
  if (!leaves.length) return collectTextValues(root).join("");

  const lines: string[] = [];
  let current = "";
  const flush = () => {
    const line = current.replace(/[ \t]+/g, " ").trimEnd();
    if (line.trim()) lines.push(line);
    current = "";
  };

  for (const leafValue of leaves) {
    const leaf = asObject(leafValue);
    if (leaf.type === "split-block") {
      flush();
      const data = asObject(leaf.data);
      if (leaf.name === "heading") {
        const level = Math.min(6, Math.max(1, Number(String(data.level || "h2").replace(/^h/i, "")) || 2));
        current = `${"#".repeat(level)} `;
      } else if (leaf.name === "list-item") {
        const depth = Math.max(0, Number(data.listLevel || 1) - 1);
        current = `${"  ".repeat(depth)}${data.listType === "ordered" ? "1." : "-"} `;
      }
      continue;
    }
    if (typeof leaf.text === "string") current += leaf.text;
  }
  flush();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function collectTextValues(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectTextValues);
  const object = value as Record<string, unknown>;
  const ownText = typeof object.text === "string" ? [object.text] : [];
  return ownText.concat(Object.entries(object)
    .filter(([key]) => key !== "text")
    .flatMap(([, child]) => collectTextValues(child)));
}

function findArrayByKey(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArrayByKey(item, key);
      if (found.length) return found;
    }
    return [];
  }
  const object = value as Record<string, unknown>;
  if (Array.isArray(object[key])) return object[key] as unknown[];
  for (const child of Object.values(object)) {
    const found = findArrayByKey(child, key);
    if (found.length) return found;
  }
  return [];
}

class MemoryCookieJar {
  private readonly cookies = new Map<string, Map<string, string>>();

  headerForHost(host: string) {
    const values = this.cookies.get(host.toLowerCase());
    return values ? [...values].map(([name, value]) => `${name}=${value}`).join("; ") : "";
  }

  hasCookieForHost(host: string) {
    return Boolean(this.cookies.get(host.toLowerCase())?.size);
  }

  capture(host: string, headers: Headers) {
    const normalizedHost = host.toLowerCase();
    const values = this.cookies.get(normalizedHost) || new Map<string, string>();
    for (const cookie of getSetCookieHeaders(headers)) {
      const pair = cookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    if (values.size) this.cookies.set(normalizedHost, values);
  }
}

async function fetchWithCookieJar<T>(
  url: string,
  jar: MemoryCookieJar,
  init: RequestInit,
  options: FetchSupportDocumentOptions & { referer: string },
  readResponse: (response: Response) => Promise<T>
) {
  const parsed = new URL(url);
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json, text/plain, */*");
  headers.set("referer", options.referer);
  const cookie = jar.headerForHost(parsed.hostname);
  if (cookie) headers.set("cookie", cookie);

  return fetchWithTimeout(url, {
    ...init,
    redirect: "manual",
    headers
  }, async (response) => {
    jar.capture(parsed.hostname, response.headers);
    return readResponse(response);
  }, options.signal);
}

async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  readResponse: (response: Response) => Promise<T>,
  parentSignal?: AbortSignal
) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REMOTE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await readResponse(response);
  } catch (error) {
    throwIfAborted(parentSignal);
    if (timedOut) throw new Error("文档服务响应超时");
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function readJsonObject(response: Response, fallbackMessage: string) {
  if (!response.ok) throw new Error(`${fallbackMessage}（HTTP ${response.status}）`);
  const payload = asObject(parseJson(await response.text()));
  if (!Object.keys(payload).length) throw new Error(`${fallbackMessage}：返回内容无法解析`);
  return payload;
}

function assertLingxiSuccess(payload: Record<string, unknown>, message: string) {
  if (Number(payload.status) === 1) return;
  throw new Error(stringValue(payload.message) || message);
}

function getSetCookieHeaders(headers: Headers) {
  const extendedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const values = extendedHeaders.getSetCookie?.() || [];
  if (values.length) return values;
  const combined = headers.get("set-cookie") || "";
  return combined ? combined.split(/,\s*(?=[^;,=\s]+=)/) : [];
}

function uniqueHttpUrls(input: string) {
  const seen = new Set<string>();
  return extractLinksFromInput(input)
    .map((link) => link.url)
    .filter((url) => {
      const key = url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function assertPublicRemoteUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("只支持 HTTP/HTTPS 公开链接");
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("支持文档不能指向本机或内网地址");
  }

  const addresses = isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("支持文档不能指向本机或内网地址");
  }
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || /^(?:fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized);
  }
  return true;
}

function findCliTextResult(value: unknown) {
  const result = asObject(asObject(value).result);
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const textBlock = content.find((item) => asObject(item).type === "text");
  return stringValue(asObject(textBlock).text);
}

function extractMarkdownTitle(content: string) {
  return content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || "";
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input.trim());
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function matchesHost(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function waitWithSignal(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const error = new Error("任务已停止");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("任务已停止");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted || (error instanceof Error && (error.name === "AbortError" || /aborted|任务已停止/i.test(error.message))));
}

function isMissingExecutable(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function formatExternalCommandError(error: unknown, fallback: string) {
  const raw = error && typeof error === "object" && "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
    ? String((error as { stderr: string }).stderr)
    : error instanceof Error ? error.message : fallback;
  return sanitizeExternalError(raw).replace(/\s+/g, " ").trim().slice(0, 500) || fallback;
}

function sanitizeExternalError(message: string) {
  return message
    .replace(/([?&](?:apikey|token|ticket|code)=)[^&\s"'<>)}\]]+/gi, "$1[已隐藏]")
    .replace(/("(?:apikey|token|ticket|code)"\s*:\s*")[^"]+/gi, "$1[已隐藏]");
}

function summarizeSupportDocumentError(error: unknown, provider: SupportDocumentProvider) {
  const message = sanitizeExternalError(error instanceof Error ? error.message : String(error || ""));
  if (/AbortError|aborted|任务已停止/i.test(message)) return "任务已停止";
  if (/BROWSER_CONNECT|browser profile .*not connected|extension .*not connected/i.test(message)) {
    return "OpenCLI 浏览器扩展未连接，请打开对应的 Chrome profile 并确认扩展已启用";
  }
  if (/timeout|timed out|ETIMEDOUT|响应超时|读取超时/i.test(message)) return `${supportDocumentProviderLabel(provider)}读取超时`;
  if (/permission|forbidden|unauthorized|401|403|无权限|权限|登录后|登录以/i.test(message)) {
    return `${supportDocumentProviderLabel(provider)}未公开，或当前工具身份没有查看权限`;
  }
  if (/not found|404|不存在|无效/i.test(message)) return "文档不存在或链接无效";
  if (/authorization expired/i.test(message)) return "企业微信文档授权已过期，请在机器人「可使用权限」中重新授权；管理员授权模式请联系管理员处理";
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || `${supportDocumentProviderLabel(provider)}读取失败`;
}
