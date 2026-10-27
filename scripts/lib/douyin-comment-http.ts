import { constants, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolveOpenCliCommand } from "../../src/lib/opencli-runtime";
import { buildCommentBenchmarkPageJs, type CommentPage } from "./douyin-comment-benchmark";

type CapturedRequest = { url: string; method: string; requestHeaders: Record<string, string> };
type BrowserCookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; expirationDate?: number };
type BrowserPage = {
  evaluate: (js: string) => Promise<CommentPage>;
  startNetworkCapture: (pattern: string) => Promise<boolean>;
  readNetworkCapture: () => Promise<CapturedRequest[]>;
  getCookies: (options: { url: string }) => Promise<BrowserCookie[]>;
};

/** 使用已安装 OpenCLI 的公开 SDK，不下载新包，也不绑定本机绝对路径。 */
async function loadBrowserPage(session: string): Promise<BrowserPage> {
  if (process.env.OPENCLI_PROFILE?.trim()) throw new Error("HTTP 评论试验暂不支持 OPENCLI_PROFILE，请使用 --transport browser");
  const runtime = resolveOpenCliCommand();
  let entry = process.env.OPENCLI_SCRIPT?.trim();
  if (!entry) {
    const names = process.platform === "win32" ? [runtime.command, `${runtime.command}.cmd`, `${runtime.command}.exe`] : [runtime.command];
    const candidates = names.flatMap(name => path.isAbsolute(name) ? [name] : (process.env.PATH || "").split(path.delimiter).map(dir => path.join(dir, name)));
    for (const candidate of candidates) {
      try { await fs.access(candidate, constants.F_OK); entry = candidate; break; }
      catch (error) {
        // 仅忽略 PATH 中不存在的候选项；权限等文件错误必须可见。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取本机 OpenCLI 安装位置");
      }
    }
  }
  if (!entry) throw new Error("没有找到已安装的 OpenCLI，请先配置 OPENCLI_BIN 或使用 --transport browser");
  try {
    const actualEntry = await fs.realpath(entry);
    const sdkPath = createRequire(actualEntry).resolve("@jackwener/opencli/browser/page");
    const sdk = await import(pathToFileURL(sdkPath).href);
    return new sdk.Page(session, undefined, undefined, "background") as BrowserPage;
  } catch {
    throw new Error("当前 OpenCLI 安装未提供可加载的浏览器 SDK，请使用 --transport browser；便携包装器可配置 OPENCLI_SCRIPT");
  }
}

export function selectCommentRequest(entries: CapturedRequest[], awemeId: string, parentId?: string) {
  const pathname = `/aweme/v1/web/comment/list/${parentId ? "reply/" : ""}`;
  for (const entry of [...entries].reverse()) {
    let url: URL;
    try { url = new URL(entry.url); } catch { continue; } // 可选捕获条目的非 URL 内容不参与请求匹配。
    if (entry.method !== "GET" || url.protocol !== "https:" || !url.hostname.endsWith(".douyin.com") || url.pathname !== pathname) continue;
    if (url.searchParams.get(parentId ? "item_id" : "aweme_id") !== awemeId || url.searchParams.get("cursor") !== "0") continue;
    if (parentId && url.searchParams.get("comment_id") !== parentId) continue;
    return entry;
  }
  throw new Error("没有捕获到该视频的真实评论读取请求，请检查 Browser Bridge 网络捕获能力，或使用 --transport browser");
}

export function cookieHeaderForCommentUrl(cookies: BrowserCookie[], url: URL, now = Date.now()) {
  return cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, "");
    const matchesDomain = url.hostname === domain || cookie.domain.startsWith(".") && url.hostname.endsWith(`.${domain}`);
    const cookiePath = cookie.path || "/";
    const matchesPath = url.pathname === cookiePath || url.pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
    return matchesDomain && matchesPath && (!cookie.secure || url.protocol === "https:") && (!cookie.expirationDate || cookie.expirationDate * 1000 > now);
  }).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

export function parseHttpCommentPage(body: string, apiMs: number): CommentPage {
  if (!body.trim()) throw new Error("HTTP 评论返回空正文，签名或登录状态可能失效；请重新运行采集或使用 --transport browser");
  let payload;
  try { payload = JSON.parse(body); } catch { throw new Error("HTTP 评论返回非 JSON，请检查 Chrome 登录或验证状态"); }
  if (!payload || typeof payload !== "object" || payload.status_code !== 0 || ![0, 1, false, true].includes(payload.has_more) || payload.cursor === undefined) {
    throw new Error("HTTP 评论返回无效状态或分页，采集尚未完成，请检查 Chrome 登录或验证状态");
  }
  const rows = payload.comments === null && !payload.has_more ? [] : payload.comments;
  if (!Array.isArray(rows)) throw new Error("HTTP 评论缺少列表，采集尚未完成");
  return { cursor: String(payload.cursor), hasMore: Boolean(payload.has_more), apiMs, bodyBytes: body.length,
    total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : undefined,
    comments: rows.map(comment => ({ id: String(comment.cid || ""), replies: Number(comment.reply_comment_total || 0), text: String(comment.text || ""),
      likes: Number(comment.digg_count || 0), author: String(comment.user?.nickname || ""), createdAt: Number(comment.create_time || 0),
      ...(Array.isArray(comment.image_list) ? { images: comment.image_list } : {}) })) };
}

/** Cookie、签名 URL 和鉴权头只保留在内存；不写入结果或错误信息。失败直接停止，不静默切换链路。 */
export async function createCapturedHttpCommentPageFetcher(session: string, awemeId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const browser = await loadBrowserPage(session);
  if (!await browser.startNetworkCapture("/comment/list/")) throw new Error("Browser Bridge 不支持网络捕获，请更新扩展或使用 --transport browser");
  const firstRoot = await browser.evaluate(buildCommentBenchmarkPageJs(awemeId, "0"));
  signal?.throwIfAborted();
  const root = selectCommentRequest(await browser.readNetworkCapture(), awemeId);
  const cookies = await browser.getCookies({ url: "https://www.douyin.com/" });
  const stats = { browserCalls: 1, httpCalls: 0, apiMs: firstRoot.apiMs || 0 };
  const firstPages = new Map<string, CommentPage>([[":0", firstRoot]]);
  let replyTemplate: CapturedRequest | undefined;
  let bootstrap: Promise<void> | undefined;
  const prepareReply = (parentId: string) => bootstrap ||= (async () => {
    signal?.throwIfAborted();
    const first = await browser.evaluate(buildCommentBenchmarkPageJs(awemeId, "0", parentId));
    signal?.throwIfAborted();
    replyTemplate = selectCommentRequest(await browser.readNetworkCapture(), awemeId, parentId);
    stats.browserCalls++;
    stats.apiMs += first.apiMs || 0;
    firstPages.set(`${parentId}:0`, first);
  })();
  const fetchPage = async (cursor: string, parentId?: string): Promise<CommentPage> => {
    signal?.throwIfAborted();
    if (parentId && !replyTemplate) await prepareReply(parentId);
    const key = `${parentId || ""}:${cursor}`;
    const first = firstPages.get(key);
    if (first) { firstPages.delete(key); return first; }
    await delay(100, undefined, { signal });
    const template = parentId ? replyTemplate! : root;
    const url = new URL(template.url);
    url.searchParams.set("cursor", cursor);
    if (parentId) url.searchParams.set("comment_id", parentId);
    stats.httpCalls++;
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { headers: { ...template.requestHeaders, cookie: cookieHeaderForCommentUrl(cookies, url) },
        redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    } catch {
      signal?.throwIfAborted();
      throw new Error("HTTP 评论连接失败或超时，已停止采集；请检查网络或使用 --transport browser");
    }
    if (!response.ok) throw new Error(`HTTP 评论返回 ${response.status}，已停止采集，请检查 Chrome 登录或验证状态`);
    let body: string;
    try { body = await response.text(); }
    catch { signal?.throwIfAborted(); throw new Error("HTTP 评论正文读取失败，已停止采集，请检查网络"); }
    const result = parseHttpCommentPage(body, Date.now() - started);
    stats.apiMs += result.apiMs || 0;
    return result;
  };
  return { fetchPage, stats };
}
