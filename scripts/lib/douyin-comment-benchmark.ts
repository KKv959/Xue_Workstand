import { DOUYIN_VERIFICATION_CHECK_JS } from "../../src/lib/opencli-douyin-scripts";

export type CollectedComment = {
  id: string;
  replies: number;
  text?: string;
  likes?: number;
  author?: string;
  createdAt?: number;
  images?: unknown[];
  parentId?: string;
};

export type CommentPage = {
  cursor: string;
  hasMore: boolean;
  total?: number;
  comments: CollectedComment[];
  apiMs?: number;
  bodyBytes?: number;
};

export type FullCommentProgress = {
  topLevelCount: number;
  replyCount: number;
  pageCount: number;
  advertisedTotal?: number;
  unavailableReplyCount: number;
  parentsWithUnavailableReplies: number;
};

/** 遍历所有可读取的一级评论与回复，不修改工作台的抽样数量。 */
export async function measureAllCommentPages(
  fetchPage: (cursor: string, parentId?: string) => Promise<CommentPage>,
  onProgress?: (progress: FullCommentProgress) => void,
  signal?: AbortSignal,
  options: { onPage?: (page: CommentPage, parentId?: string) => Promise<void>; replyConcurrency?: number } = {}
) {
  const parents = new Map<string, number>();
  const replies = new Set<string>();
  let pageCount = 0;
  let advertisedTotal: number | undefined;
  let unavailableReplyCount = 0;
  let parentsWithUnavailableReplies = 0;
  const progress = (): FullCommentProgress => ({ topLevelCount: parents.size, replyCount: replies.size, pageCount, advertisedTotal, unavailableReplyCount, parentsWithUnavailableReplies });
  const traverse = async (parentId?: string) => {
    let cursor = "0";
    const cursors = new Set<string>();
    const parentReplies = new Set<string>();
    while (true) {
      signal?.throwIfAborted();
      if (cursors.has(cursor)) throw new Error("抖音评论分页游标重复，采集尚未完成");
      cursors.add(cursor);
      const page = await fetchPage(cursor, parentId);
      pageCount++;
      if (!parentId && page.total !== undefined) advertisedTotal = page.total;
      for (const comment of page.comments) {
        if (!comment.id) throw new Error("抖音评论缺少 ID，无法核对全量采集结果");
        if (parentId) { replies.add(comment.id); parentReplies.add(comment.id); }
        else parents.set(comment.id, Math.max(parents.get(comment.id) || 0, comment.replies));
      }
      onProgress?.(progress());
      await options.onPage?.(page, parentId);
      if (!page.hasMore) break;
      if (!page.comments.length) throw new Error("抖音返回空评论页但仍有后续评论，采集尚未完成");
      cursor = page.cursor;
    }
    if (parentId) {
      const missing = Math.max(0, (parents.get(parentId) || 0) - parentReplies.size);
      if (missing) { unavailableReplyCount += missing; parentsWithUnavailableReplies++; }
      onProgress?.(progress());
    }
  };
  await traverse();
  const parentIds = [...parents].filter(([, count]) => count > 0).map(([id]) => id);
  let nextIndex = 0;
  let failure: unknown;
  const concurrency = Math.min(2, Math.max(1, Math.trunc(options.replyConcurrency || 1)), parentIds.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!failure && nextIndex < parentIds.length) {
      const parentId = parentIds[nextIndex++];
      try { await traverse(parentId); }
      catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return { ...progress(), accessiblePagesExhausted: true };
}

type CommentRequestOptions = {
  pageSize?: number;
  extraParams?: Record<string, string>;
  transport?: "fetch" | "xhr";
};

export function buildCommentBenchmarkPageJs(awemeId: string, cursor: string, parentId?: string, options: CommentRequestOptions = {}) {
  return `(async () => {
    const awemeId = ${JSON.stringify(awemeId)};
    const requestCursor = ${JSON.stringify(cursor)};
    const parentId = ${JSON.stringify(parentId || "")};
    ${buildCommentPageReadBodyJs(options)}
  })()`;
}

function buildCommentPageReadBodyJs(options: CommentRequestOptions) {
  return `
  if (${DOUYIN_VERIFICATION_CHECK_JS}) {
    throw new Error("抖音登录或安全验证未通过，请在 Chrome 完成验证码后再测全量评论");
  }
  const startedAt = performance.now();
  const url = new URL(parentId ? "https://www.douyin.com/aweme/v1/web/comment/list/reply/" : "https://www.douyin.com/aweme/v1/web/comment/list/");
  for (const [key, value] of Object.entries({ cursor: requestCursor, count: ${JSON.stringify(String(options.pageSize || 50))}, item_type: "0", device_platform: "webapp", aid: "6383" })) url.searchParams.set(key, value);
  url.searchParams.set(parentId ? "item_id" : "aweme_id", awemeId);
  if (parentId) url.searchParams.set("comment_id", parentId);
  else for (const [key, value] of Object.entries({ insert_ids: "", whale_cut_token: "", cut_version: "1", rcFT: "" })) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries(${JSON.stringify(options.extraParams || {})})) url.searchParams.set(key, value);
  const response = ${options.transport === "xhr" ? `await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url.toString()); xhr.withCredentials = true; xhr.timeout = 15000;
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: async () => xhr.responseText });
    xhr.onerror = () => reject(new Error("抖音评论 XHR 网络请求失败"));
    xhr.ontimeout = () => reject(new Error("抖音评论 XHR 请求超时")); xhr.send();
  })` : `await fetch(url.toString(), { credentials: "include", headers: { accept: "application/json, text/plain, */*" }, signal: AbortSignal.timeout(15000) })`};
  if (!response.ok) throw new Error("抖音评论接口 HTTP " + response.status + "，全量采集尚未完成，请检查 Chrome 登录或验证状态");
  const body = await response.text();
  if (!body.trim()) throw new Error("抖音评论接口返回空正文，全量采集尚未完成，请检查 Chrome 登录或验证状态");
  let payload;
  try { payload = JSON.parse(body); }
  catch { throw new Error("抖音评论接口返回非 JSON 内容，全量采集尚未完成，请检查 Chrome 登录或验证状态"); }
  if (!payload || typeof payload !== "object") throw new Error("抖音评论接口返回无效结果，全量采集尚未完成");
  if (Number(payload.status_code || 0) !== 0) throw new Error("抖音评论接口状态 " + payload.status_code + "：" + (payload.status_msg || "采集尚未完成"));
  if (![0, 1, false, true].includes(payload.has_more) || payload.cursor === undefined) throw new Error("抖音评论接口缺少有效分页字段，全量采集尚未完成");
  // 实测已无可读回复时可返回 comments:null、has_more:0，父评论的回复计数却仍大于零。
  const comments = payload.comments === null && !payload.has_more ? [] : payload.comments;
  if (!Array.isArray(comments)) throw new Error("抖音评论接口缺少评论列表，全量采集尚未完成");
  return { cursor: String(payload.cursor), hasMore: Boolean(payload.has_more), apiMs: Math.round(performance.now() - startedAt), bodyBytes: body.length,
    total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : undefined,
    comments: comments.map(comment => ({ id: String(comment.cid || ""), replies: Number(comment.reply_comment_total || 0),
      text: String(comment.text || ""), likes: Number(comment.digg_count || 0), author: String(comment.user?.nickname || ""),
      createdAt: Number(comment.create_time || 0), ...(Array.isArray(comment.image_list) ? { images: comment.image_list } : {}) })) };
`;
}

export type CommentPageRequest = { cursor: string; parentId?: string };
export type CommentPageBatch = {
  pages: Array<{ requestCursor: string; page: CommentPage }>;
  error?: string;
  errorCursor?: string;
};

/** 一次浏览器调用连续翻最多五页，不增加同一列表的请求并发。 */
export function buildCommentBenchmarkBatchJs(awemeId: string, requests: CommentPageRequest[], options: {
  pageSize?: number; batchPages?: number; intervalMs?: number;
} = {}) {
  const batchPages = Math.max(1, Math.min(5, Math.trunc(options.batchPages || 5)));
  const pageSize = Math.max(1, Math.min(50, Math.trunc(options.pageSize || 50)));
  const intervalMs = Math.max(0, Math.min(1000, Math.trunc(options.intervalMs ?? 0)));
  if (!requests.length || requests.length > 2) throw new Error("评论批量请求必须为 1 至 2 个独立列表");
  return `(async () => {
    const awemeId = ${JSON.stringify(awemeId)};
    const requests = ${JSON.stringify(requests)};
    const read = async (requestCursor, parentId) => { ${buildCommentPageReadBodyJs({ pageSize })} };
    return Promise.all(requests.map(async request => {
      const pages = [];
      const cursors = new Set();
      let cursor = request.cursor;
      const deadline = Date.now() + 8000;
      try {
        for (let index = 0; index < ${batchPages}; index++) {
          if (cursors.has(cursor)) throw new Error("抖音评论分页游标重复，采集尚未完成");
          cursors.add(cursor);
          const page = await read(cursor, request.parentId || "");
          pages.push({ requestCursor: cursor, page });
          if (!page.hasMore) break;
          if (!page.comments.length) throw new Error("抖音返回空评论页但仍有后续评论，采集尚未完成");
          cursor = page.cursor;
          if (Date.now() >= deadline) break;
          if (${intervalMs} > 0 && index + 1 < ${batchPages}) await new Promise(resolve => setTimeout(resolve, ${intervalMs}));
        }
        return { pages };
      } catch (error) {
        return { pages, error: String(error?.message || error), errorCursor: cursor };
      }
    }));
  })()`;
}

/** 合并同一轮独立列表的读取，并把批次中成功的页交给原有全量遍历器逐页保存。 */
export function createBufferedCommentPageFetcher(fetchBatch: (requests: CommentPageRequest[]) => Promise<CommentPageBatch[]>) {
  const cache = new Map<string, CommentPage | Error>();
  type Pending = { request: CommentPageRequest; resolve: (page: CommentPage) => void; reject: (error: unknown) => void };
  const pending: Pending[] = [];
  const key = (cursor: string, parentId?: string) => `${parentId || ""}:${cursor}`;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // 留出原子落盘完成的几个毫秒，避免一个楼中楼先入队后立即独占批次。
    setTimeout(async () => {
      const group = pending.splice(0, 2);
      try {
        const rows = await fetchBatch(group.map(item => item.request));
        if (!Array.isArray(rows) || rows.length !== group.length) throw new Error("抖音批量评论接口缺少列表结果，采集尚未完成");
        for (let index = 0; index < group.length; index++) {
          const item = group[index];
          const row = rows[index];
          if (!Array.isArray(row.pages)) throw new Error("抖音批量评论接口缺少分页结果，采集尚未完成");
          for (const { requestCursor, page } of row.pages) cache.set(key(requestCursor, item.request.parentId), page);
          if (row.error) cache.set(key(row.errorCursor || item.request.cursor, item.request.parentId), new Error(row.error));
        }
        for (const item of group) {
          const first = cache.get(key(item.request.cursor, item.request.parentId));
          cache.delete(key(item.request.cursor, item.request.parentId));
          if (!first || first instanceof Error) item.reject(first || new Error("抖音批次未返回请求的评论页，采集尚未完成"));
          else item.resolve(first);
        }
      } catch (error) {
        for (const item of group) item.reject(error);
      } finally {
        scheduled = false;
        if (pending.length) schedule();
      }
    }, 10);
  };
  return (cursor: string, parentId?: string): Promise<CommentPage> => {
    const cached = cache.get(key(cursor, parentId));
    if (cached) {
      cache.delete(key(cursor, parentId));
      return cached instanceof Error ? Promise.reject(cached) : Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => { pending.push({ request: { cursor, parentId }, resolve, reject }); schedule(); });
  };
}
