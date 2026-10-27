import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { buildOpenCliBrowserArgs, parseJsonish, runOpenCli, sharedOpenCliBrowserSession, withSharedOpenCliBrowserSession } from "./opencli-runtime";
import type { BilibiliCommentSample } from "./opencli-bilibili";
import type { CommentCollectionAttempt } from "./engagement-source-selection";

// 与 OpenCLI bilibili/utils.js 的 WBI 排列和编码保持一致。
const mixinOrder = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const envelope = z.object({ code: z.number(), data: z.unknown().optional() });
const replySchema = z.object({
  rpid_str: z.string().optional(), rpid: z.union([z.string(), z.number()]).optional(),
  content: z.object({ message: z.string().optional() }).optional(),
  member: z.object({ uname: z.string().optional() }).optional(),
  like: z.number().optional(), rcount: z.number().optional(), ctime: z.number().optional()
});
const pageSchema = z.object({
  cursor: z.object({ next: z.number().int().nonnegative().optional(), is_end: z.boolean() }),
  replies: z.array(replySchema).nullable(), top_replies: z.array(replySchema).nullish(),
  top: z.object({ upper: replySchema.nullish() }).nullish()
});

function apiData(value: unknown) {
  const result = envelope.safeParse(value);
  if (!result.success) throw new Error("B站评论接口返回字段异常，请检查浏览器会话后重试。");
  if (result.data.code !== 0) throw new Error(`B站评论接口返回 ${result.data.code}，请检查登录、验证或访问限制。`);
  return result.data.data;
}

export function signBilibiliCommentUrl(aid: string, imgKey: string, subKey: string, next: number, timestamp = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/.test(aid) || !/^[a-f0-9]{32}$/i.test(imgKey) || !/^[a-f0-9]{32}$/i.test(subKey)) throw new Error("B站评论签名参数不完整，请重新建立浏览器会话。");
  const raw = imgKey + subKey;
  const key = mixinOrder.map((index) => raw[index]).join("").slice(0, 32);
  const params: Record<string, string> = { oid: aid, type: "1", mode: "3", ps: "50", next: String(next), wts: String(timestamp) };
  const query = Object.keys(params).sort().map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(params[name].replace(/[!'()*]/g, ""))}`).join("&");
  return `https://api.bilibili.com/x/v2/reply/wbi/main?${query}&w_rid=${createHash("md5").update(query + key).digest("hex")}`;
}

export function parseBilibiliCommentPage(value: unknown, includePinned: boolean) {
  const parsed = pageSchema.safeParse(apiData(value));
  if (!parsed.success) throw new Error(`B站评论分页字段不完整（${parsed.error.issues.map((issue) => issue.path.join(".")).join("、")}），已停止采集。`);
  const data = parsed.data;
  if (!data.cursor.is_end && !data.replies?.length) throw new Error("B站评论分页返回空页但仍有后续，采集未完成。");
  if (!data.cursor.is_end && !Number.isSafeInteger(data.cursor.next)) throw new Error("B站评论分页缺少有效游标。");
  const pinned = includePinned ? [...(data.top_replies || []), ...(data.top?.upper ? [data.top.upper] : [])] : [];
  return { rows: [...pinned, ...(data.replies || [])], next: data.cursor.next ?? 0, end: data.cursor.is_end };
}

const COMMENT_PAGE_LIMIT = 20;
const COMMENT_PAGE_INTERVAL_MS = 500;

/** 读取一个 B站接口；标签页不在 www.bilibili.com 时返回 needsSession，由调用方打开首页一次后重试。 */
function readJsonScript(url: string) {
  return `(async () => {
    if (location.hostname !== "www.bilibili.com") return { needsSession: true };
    const response = await fetch(${JSON.stringify(url)}, { credentials: "include", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("B站评论接口 HTTP " + response.status + "，请检查登录或访问限制");
    return response.json();
  })()`;
}

const BILIBILI_COUNT_PAGE_CONCURRENCY = 3;
const countRowsSchema = z.array(z.object({ bvid: z.string(), value: z.unknown().optional(), error: z.string().optional() }));

function readViewCountsScript(bvids: string[]) {
  return `(async () => {
    if (location.hostname !== "www.bilibili.com") throw new Error("B站评论浏览器会话不匹配，请重试");
    const ids = ${JSON.stringify(bvids)};
    const results = new Array(ids.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(${BILIBILI_COUNT_PAGE_CONCURRENCY}, ids.length) }, async () => {
      while (cursor < ids.length) {
        const index = cursor++;
        try {
          const response = await fetch("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(ids[index]), { credentials: "include", signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error("B站评论接口 HTTP " + response.status + "，请检查登录或访问限制");
          results[index] = { bvid: ids[index], value: await response.json() };
        } catch (error) {
          results[index] = { bvid: ids[index], error: String((error && error.message) || error) };
        }
      }
    }));
    return results;
  })()`;
}

/** 一次打开会话、一次页面内有界并发读取多条视频的评论总数，替代逐条 open + eval。 */
export async function getBilibiliSourceCommentCounts(bvids: string[], signal?: AbortSignal): Promise<Map<string, number | undefined | Error>> {
  const ids = [...new Set(bvids)];
  if (!ids.length) return new Map();
  if (ids.some((bvid) => !/^BV[0-9A-Za-z]{10}$/.test(bvid))) throw new Error("B站评论数核验需要有效的视频 BV 号。");
  return withSharedOpenCliBrowserSession(async (session) => {
    await runOpenCli(buildOpenCliBrowserArgs(session, "open", ["https://www.bilibili.com"], { window: "background" }), { signal, timeout: 30_000 });
    const rows = countRowsSchema.safeParse(parseJsonish(await runOpenCli(buildOpenCliBrowserArgs(session, "eval", [readViewCountsScript(ids)]),
      { signal, timeout: Math.max(20_000, Math.ceil(ids.length / BILIBILI_COUNT_PAGE_CONCURRENCY) * 15_000) })));
    if (!rows.success) throw new Error("B站评论数核验返回字段异常，请检查浏览器会话后重试。");
    const counts = new Map<string, number | undefined | Error>();
    for (const row of rows.data) {
      if (row.error) {
        counts.set(row.bvid, new Error(row.error));
        continue;
      }
      try {
        const view = z.object({ stat: z.object({ reply: z.number().int().nonnegative() }) }).safeParse(apiData(row.value));
        counts.set(row.bvid, view.success ? view.data.stat.reply : undefined);
      } catch (error) {
        counts.set(row.bvid, error instanceof Error ? error : new Error(String(error)));
      }
    }
    for (const bvid of ids) if (!counts.has(bvid)) counts.set(bvid, new Error("B站评论数核验没有返回该视频的结果。"));
    return counts;
  }, { signal, session: sharedOpenCliBrowserSession() + "-bilibili-comments" });
}

export async function getBilibiliExpandedComments(bvid: string, limit: number, signal?: AbortSignal, onCollection?: (trace: CommentCollectionAttempt) => void): Promise<BilibiliCommentSample[]> {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error("B站评论采集需要有效的视频 BV 号。");
  const target = Math.max(1, Math.min(200, Math.trunc(limit)));
  const started = Date.now();
  const trace: CommentCollectionAttempt = { videoId: bvid, requestedCount: target, collectedCount: 0, pages: [], stopReason: "failed", elapsedMs: 0 };
  try {
    return await withSharedOpenCliBrowserSession(async (session) => {
      // 评论接口只需 www.bilibili.com 同源会话，不再逐个打开视频页；节流在 Node 端，后台标签页的计时器会被 Chrome 拉长到 1 秒。
      const evalJson = async (url: string) => parseJsonish(await runOpenCli(buildOpenCliBrowserArgs(session, "eval", [readJsonScript(url)]), { signal, timeout: 20_000 }));
      const needsSession = (value: unknown) => Boolean(value && typeof value === "object" && (value as { needsSession?: unknown }).needsSession === true);
      const read = async (url: string) => {
        const value = await evalJson(url);
        if (!needsSession(value)) return value;
        await runOpenCli(buildOpenCliBrowserArgs(session, "open", ["https://www.bilibili.com"], { window: "background" }), { signal, timeout: 30_000 });
        const retried = await evalJson(url);
        if (needsSession(retried)) throw new Error("B站评论浏览器会话不匹配，请重试。");
        return retried;
      };
      const nav = z.object({ isLogin: z.boolean(), wbi_img: z.object({ img_url: z.string(), sub_url: z.string() }) }).safeParse(apiData(await read("https://api.bilibili.com/x/web-interface/nav")));
      if (!nav.success || !nav.data.isLogin) throw new Error("B站登录不可用，请在 Chrome 登录后重试评论采集。");
      const view = z.object({ aid: z.union([z.string(), z.number()]) }).safeParse(apiData(await read(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)));
      if (!view.success) throw new Error("B站未返回评论所需的视频 aid。");
      const key = (url: string) => url.split("/").pop()?.split(".")[0] || "";
      const rows: BilibiliCommentSample[] = [];
      const seenIds = new Set<string>();
      const cursors = new Set<number>();
      let next = 0;
      let lastRequestAt = 0;
      for (let page = 0; page < COMMENT_PAGE_LIMIT && rows.length < target; page += 1) {
        if (signal?.aborted) throw signal.reason || new Error("评论采集已取消");
        if (cursors.has(next)) throw new Error("B站评论分页游标重复，已停止采集。");
        cursors.add(next);
        const wait = Math.max(0, COMMENT_PAGE_INTERVAL_MS - (Date.now() - lastRequestAt));
        if (wait) await delay(wait, undefined, { signal });
        lastRequestAt = Date.now();
        const parsed = parseBilibiliCommentPage(await read(signBilibiliCommentUrl(String(view.data.aid), key(nav.data.wbi_img.img_url), key(nav.data.wbi_img.sub_url), next)), page === 0);
        const before = rows.length;
        for (const row of parsed.rows) {
          const id = row.rpid_str || String(row.rpid || "");
          const text = row.content?.message?.replace(/\s+/g, " ").trim();
          if (!id || !text || seenIds.has(id)) continue;
          seenIds.add(id);
          rows.push({ rank: rows.length + 1, rpid: id, text, author: row.member?.uname || "", likes: row.like || 0, replies: row.rcount || 0, time: row.ctime ? new Date(row.ctime * 1000).toISOString() : "" });
          if (rows.length >= target) break;
        }
        trace.collectedCount = rows.length;
        trace.pages.push({ cursor: next, nextCursor: parsed.next, returnedCount: parsed.rows.length, addedCount: rows.length - before, hasMore: !parsed.end });
        if (parsed.end || rows.length >= target) {
          trace.stopReason = rows.length >= target ? "target_reached" : "exhausted";
          return rows;
        }
        next = parsed.next;
      }
      throw new Error("B站评论分页达到请求上限仍未完成，已停止采集，请稍后重试。");
    }, { signal, session: sharedOpenCliBrowserSession() + "-bilibili-comments" });
  } catch (error) {
    trace.stopReason = signal?.aborted ? "cancelled" : "failed";
    trace.error = error instanceof Error ? error.message : "B站评论采集失败";
    throw error;
  } finally {
    trace.elapsedMs = Date.now() - started;
    onCollection?.(trace);
  }
}
