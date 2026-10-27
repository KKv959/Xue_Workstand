import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { extractLinksFromInput } from "./platform-links";
import { clampText } from "./utils";

const execFileAsync = promisify(execFile);
const HIDDEN_CHILD_PROCESS_OPTIONS = { windowsHide: true };

type FeishuConfig = {
  folderToken: string;
  opencliBin: string;
  identity: string;
};

export type FeishuFetchedDocument = {
  url: string;
  title?: string;
  content?: string;
  error?: string;
};

function feishuConfig(): FeishuConfig {
  return {
    folderToken: process.env.FEISHU_FOLDER_TOKEN || "",
    opencliBin: process.env.LARK_CLI_BIN?.trim() || "lark-cli",
    identity: process.env.FEISHU_OPENCLI_AS || "user"
  };
}

export function getFeishuRuntimeConfig() {
  const config = feishuConfig();
  return {
    configured: true,
    mode: "lark-cli" as const,
    opencliBin: config.opencliBin,
    identity: config.identity,
    folderConfigured: Boolean(config.folderToken)
  };
}

export async function checkFeishuRuntime() {
  const config = feishuConfig();
  const runtimeConfig = getFeishuRuntimeConfig();
  try {
    const { stdout, stderr } = await execFileAsync(config.opencliBin, ["doctor", "--offline"], {
      ...HIDDEN_CHILD_PROCESS_OPTIONS,
      maxBuffer: 1024 * 1024,
      timeout: 10000
    });
    return {
      ...runtimeConfig,
      configured: true,
      available: true,
      doctor: {
        ok: true,
        message: (stdout || stderr).trim()
      }
    };
  } catch (error) {
    return {
      ...runtimeConfig,
      configured: false,
      available: false,
      doctor: {
        ok: false,
        message: error instanceof Error ? error.message : "lark-cli doctor 检查失败"
      }
    };
  }
}

export async function publishFeishuDocument(input: { title: string; content: string }) {
  return publishWithLarkCli(feishuConfig(), input);
}

export async function fetchFeishuSupportDocuments(input: string, options: { signal?: AbortSignal } = {}) {
  throwIfAborted(options.signal);
  const refs = uniqueFeishuDocRefs(input).slice(0, 4);
  if (!refs.length) return [];

  const config = feishuConfig();
  const documents: FeishuFetchedDocument[] = [];
  for (const ref of refs) {
    throwIfAborted(options.signal);
    documents.push(await fetchFeishuDocument(config, ref, options));
  }
  return documents;
}

export function hasFeishuDocLink(input?: string) {
  return uniqueFeishuDocRefs(input || "").length > 0;
}

export function extractFeishuSupportDocumentRefs(input?: string) {
  return uniqueFeishuDocRefs(input || "");
}

async function publishWithLarkCli(config: FeishuConfig, input: { title: string; content: string }) {
  const args = [
    "docs",
    "+create",
    "--title",
    input.title || "写作台生成文档",
    "--doc-format",
    "markdown",
    "--content",
    "-",
    "--as",
    config.identity
  ];
  if (config.folderToken) args.push("--parent-token", config.folderToken);

  const { stdout, stderr } = await spawnWithInput(config.opencliBin, args, input.content, {
    maxBuffer: 1024 * 1024 * 20,
    timeout: 120000
  });
  const output = stdout.trim();
  const payload = parseJsonish(output);
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const nested = data.data && typeof data.data === "object" ? (data.data as Record<string, unknown>) : {};
  const document = nested.document && typeof nested.document === "object" ? nested.document as Record<string, unknown> : {};
  const documentId = String(document.document_id || nested.doc_id || nested.document_id || data.doc_id || data.document_id || "");
  const url = String(document.url || nested.doc_url || nested.url || data.doc_url || data.url || "");

  if (!documentId && !url) {
    throw new Error(`飞书文档创建失败：${stderr.trim() || output || "lark-cli 未返回文档链接"}`);
  }

  return {
    title: input.title,
    documentId,
    url: url || `https://www.feishu.cn/docx/${documentId}`
  };
}

async function fetchFeishuDocument(
  config: FeishuConfig,
  url: string,
  options: { signal?: AbortSignal } = {}
): Promise<FeishuFetchedDocument> {
  const args = [
    "docs",
    "+fetch",
    "--doc",
    url,
    "--doc-format",
    "markdown",
    "--detail",
    "simple",
    "--format",
    "json",
    "--as",
    config.identity
  ];

  try {
    throwIfAborted(options.signal);
    const { stdout, stderr } = await execFileAsync(config.opencliBin, args, {
      ...HIDDEN_CHILD_PROCESS_OPTIONS,
      maxBuffer: 1024 * 1024 * 20,
      timeout: 60000,
      signal: options.signal
    });
    const payload = parseJsonish(stdout.trim());
    const document = extractFetchedDocument(payload);
    if (!document.content.trim()) {
      return {
        url,
        title: document.title,
        error: stderr.trim() || "lark-cli 没有返回可用正文"
      };
    }
    return {
      url,
      title: document.title,
      content: clampText(document.content.trim(), 5000)
    };
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error;
    return {
      url,
      error: summarizeFeishuFetchError(error)
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

function spawnWithInput(command: string, args: string[], input: string, options: { maxBuffer: number; timeout: number }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("飞书文档创建超时"));
    }, options.timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > options.maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error("飞书文档创建输出过大"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > options.maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error("飞书文档创建错误输出过大"));
      }
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(stderr.trim() || `飞书文档创建失败：lark-cli 退出码 ${code}`));
    });

    child.stdin.end(input);
  });
}

function uniqueFeishuDocRefs(input: string) {
  const refs: string[] = [];
  const variants = collectFeishuInputVariants(input);

  for (const text of variants) {
    for (const link of extractLinksFromInput(text)) {
      if (isFeishuDocUrl(link.url)) refs.push(link.url);
      refs.push(...extractFeishuDocRefsFromDeepLink(link.url));
    }

    for (const match of text.matchAll(FEISHU_DOMAIN_URL_PATTERN)) {
      const url = normalizeFeishuUrlToken(match[0]);
      if (url && isFeishuDocUrl(url)) refs.push(url);
    }

    for (const token of text.split(/[\s,，;；]+/)) {
      const ref = normalizePotentialFeishuDocToken(token);
      if (ref) refs.push(ref);
    }
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }

  return unique;
}

function isFeishuDocUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$|(^|\.)feishu-boe\.cn$/i.test(host)) return false;
    return /\/(?:docx|docs|doc|wiki)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

const FEISHU_DOMAIN_URL_PATTERN =
  /(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com|feishu-boe\.cn)\/[^\s<>"']+/gi;
const WRAPPED_FEISHU_TOKEN_PATTERN = /^[A-Za-z0-9%=_+-]{20,180}\.[a-f0-9]{24,128}$/i;
const NAMED_FEISHU_TOKEN_PATTERN = /^(?:docxcn|doxcn|doccn|wikcn)[A-Za-z0-9_-]{8,}$/i;

function collectFeishuInputVariants(input: string) {
  const variants = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) variants.add(trimmed);
  };

  add(input);

  const decodedInput = decodeUriComponentLoose(input);
  if (decodedInput !== input) add(decodedInput);

  for (const token of input.match(/[A-Za-z0-9+/_=-]{20,}(?:%3D|=)?/gi) || []) {
    const decoded = decodeBase64Loose(decodeUriComponentLoose(token));
    if (decoded && /feishu|larksuite|docx|docs|wiki|https?:\/\//i.test(decoded)) add(decoded);
  }

  return [...variants];
}

function normalizeFeishuUrlToken(token: string) {
  const trimmed = trimDocumentRefToken(token);
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function extractFeishuDocRefsFromDeepLink(url: string) {
  const refs: string[] = [];
  try {
    const parsed = new URL(url);
    for (const value of parsed.searchParams.values()) {
      const decoded = decodeUriComponentLoose(value);
      if (isFeishuDocUrl(decoded)) refs.push(decoded);
    }
  } catch {
    // Ignore malformed deep links; they may still be tried as raw tokens below.
  }
  return refs;
}

function normalizePotentialFeishuDocToken(token: string) {
  const trimmed = trimDocumentRefToken(token);
  if (!trimmed || /^https?:\/\//i.test(trimmed) || /[/:]/.test(trimmed)) return "";

  const decoded = decodeUriComponentLoose(trimmed);
  if (isLikelyFeishuDocToken(decoded)) return decoded;
  if (isLikelyFeishuDocToken(trimmed)) return trimmed;
  return "";
}

function trimDocumentRefToken(token: string) {
  return token.trim().replace(/^[<"'「『（(【\[]+/, "").replace(/[>"'」』）)】\]，。！？、；;,.!?]+$/g, "");
}

function isLikelyFeishuDocToken(token: string) {
  if (NAMED_FEISHU_TOKEN_PATTERN.test(token)) return true;
  if (WRAPPED_FEISHU_TOKEN_PATTERN.test(token)) return true;
  return false;
}

function decodeUriComponentLoose(value: string) {
  let current = value;
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function decodeBase64Loose(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractFetchedDocument(payload: unknown) {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  const document = data.document && typeof data.document === "object" ? (data.document as Record<string, unknown>) : data;
  return {
    title: stringValue(document.title || document.name || data.title || root.title),
    content:
      stringValue(document.content || document.markdown || document.text || data.content || data.markdown || data.text || root.content) ||
      findStringByKey(payload, ["content", "markdown", "text"])
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function findStringByKey(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keys);
      if (found) return found;
    }
    return "";
  }

  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  for (const candidate of Object.values(object)) {
    const found = findStringByKey(candidate, keys);
    if (found) return found;
  }
  return "";
}

function summarizeFeishuFetchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/timeout|ETIMEDOUT|timed out/i.test(message)) return "lark-cli 读取超时";
  if (/permission|forbidden|403|unauthorized|401|无权限|权限/i.test(message)) return "当前 lark-cli 身份没有文档权限";
  if (/not found|404|不存在/i.test(message)) return "文档不存在或链接无效";
  if (/field validation failed|99992402|400/i.test(message)) {
    return "文档标识无效。请粘贴浏览器地址栏里的飞书文档链接，或 docx/doxcn/wikcn 开头的文档 token";
  }
  if (/not found: lark-cli|ENOENT/i.test(message)) return "没有找到 lark-cli，请检查 LARK_CLI_BIN";
  return message || "lark-cli 读取失败";
}

function parseJsonish(output: string): unknown {
  if (!output) return {};
  try {
    return JSON.parse(output);
  } catch {
    const firstBrace = output.indexOf("{");
    const firstBracket = output.indexOf("[");
    const candidates = [firstBrace, firstBracket].filter((index) => index >= 0);
    const start = Math.min(...candidates);
    if (Number.isFinite(start)) {
      const jsonText = extractBalancedJson(output.slice(start));
      if (jsonText) {
        try {
          return JSON.parse(jsonText);
        } catch {
          return {};
        }
      }
      try {
        return JSON.parse(output.slice(start));
      } catch {
        return {};
      }
    }
    return {};
  }
}

function extractBalancedJson(input: string) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return input.slice(0, index + 1);
    }
  }
  return "";
}
