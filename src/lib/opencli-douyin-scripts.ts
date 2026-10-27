const DOUYIN_BROWSER_SEARCH_LIMIT = 12;
const DOUYIN_POST_PAGE_SIZE = 20;

export const DOUYIN_SEARCH_EXTRACT_JS = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const normalizeUrl = (href) => {
    if (!href) return "";
    if (href.startsWith("//")) return "https:" + href;
    if (href.startsWith("/")) return location.origin + href;
    return href;
  };
  const followerValue = (text) => {
    const match = clean(text).match(/([0-9.]+\\s*[万億亿kKmM]?)\\s*粉丝/);
    return match ? match[1] : "";
  };
  const extract = () => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/user/"]'))
      .map((anchor, index) => {
        const href = normalizeUrl(anchor.getAttribute("href") || anchor.href || "");
        const match = href.match(/\\/user\\/([^/?#]+)/);
        const secUid = match ? decodeURIComponent(match[1]) : "";
        if (!secUid || secUid === "self" || seen.has(secUid)) return null;
        seen.add(secUid);
        const lines = String(anchor.innerText || anchor.textContent || "")
          .split(/\\n+/)
          .map(clean)
          .filter(Boolean);
        const nickname = lines.find((line) => line !== "关注" && !/^抖音号[:：]/.test(line)) || "";
        const rawText = clean(lines.join(" "));
        return {
          rank: index + 1,
          nickname,
          name: nickname,
          title: nickname,
          sec_uid: secUid,
          sec_user_id: secUid,
          follower_count: followerValue(rawText),
          url: href,
          raw_text: rawText
        };
      })
      .filter(Boolean);
  };

  for (let i = 0; i < 8; i += 1) {
    const rows = extract();
    if (rows.length) return rows.slice(0, ${DOUYIN_BROWSER_SEARCH_LIMIT});
    await sleep(1000);
  }
  return extract().slice(0, ${DOUYIN_BROWSER_SEARCH_LIMIT});
})()
`;

export const DOUYIN_RELATED_VIDEO_EXTRACT_JS = `
(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const isTitleLike = (line) => {
    const text = clean(line);
    if (!text || text === "相关搜索") return false;
    if (/^@/.test(text)) return false;
    if (/^(关注|粉丝|合集|直播中|广告|查看更多|搜索|大家都在搜|用户|音乐)$/.test(text)) return false;
    if (/^\\d{1,2}:\\d{2}$/.test(text)) return false;
    if (/^\\d+(\\.\\d+)?\\s*[万億亿kKmM]?$/.test(text)) return false;
    if (/^(点赞|评论|分享|收藏|转发)\\s*\\d*/.test(text)) return false;
    if (/^(\\d+\\s*)?(分钟前|小时前|天前|周前|月前|年前)$/.test(text)) return false;
    return /[\\u4e00-\\u9fa5A-Za-z]/.test(text) && text.length >= 2;
  };
  const pickTitle = (lines, fallback = "") => {
    const values = lines.map(clean).filter(Boolean);
    return values.find((line) => isTitleLike(line) && !/^#/.test(line)) ||
      values.find(isTitleLike) ||
      clean(fallback);
  };
  const numberValue = (text) => {
    const match = clean(text).match(/([0-9.]+)\\s*([万億亿kKmM]?)/);
    if (!match) return 0;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;
    const unit = String(match[2] || "").toLowerCase();
    if (unit === "万") return Math.round(base * 10000);
    if (unit === "亿" || unit === "億") return Math.round(base * 100000000);
    if (unit === "k") return Math.round(base * 1000);
    if (unit === "m") return Math.round(base * 1000000);
    return Math.round(base);
  };
  const seen = new Set();
  const byWaterfall = Array.from(document.querySelectorAll('[id^="waterfall_item_"]'))
    .map((element) => {
      const id = String(element.id || "").replace(/^waterfall_item_/, "");
      const lines = String(element.innerText || element.textContent || "")
        .split(/\\n+/)
        .map(clean)
        .filter(Boolean);
      const title = pickTitle(lines);
      const likes = numberValue(lines.find((line) => /^\\d/.test(line) && !/^\\d{1,2}:\\d{2}/.test(line)) || "");
      if (!id || seen.has(id) || !title || title === "相关搜索") return null;
      seen.add(id);
      return { id, aweme_id: id, title, likes, url: location.origin + "/video/" + id };
    })
    .filter(Boolean);

  const byLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'))
    .map((anchor) => {
      const href = anchor.getAttribute("href") || anchor.href || "";
      const match = href.match(/\\/video\\/(\\d+)/);
      const id = match ? match[1] : "";
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const container = anchor.closest("li") || anchor.closest("div");
      const lines = String(container?.innerText || anchor.innerText || anchor.textContent || "")
        .split(/\\n+/)
        .map(clean)
        .filter(Boolean);
      const title = pickTitle(lines, anchor.innerText || anchor.textContent || "");
      const likes = numberValue(lines.find((line) => /^\\d/.test(line) && !/^\\d{1,2}:\\d{2}/.test(line)) || "");
      return title ? { id, aweme_id: id, title, likes, url: location.origin + "/video/" + id } : null;
    })
    .filter(Boolean);

  return [...byWaterfall, ...byLinks].slice(0, 30);
})()
`;

/** 抖音正常页面也常驻隐藏的验证 iframe，只拦截实际显示的验证窗口。 */
export const DOUYIN_VERIFICATION_CHECK_JS = `(() => {
  if (/^(?:验证码中间页|安全验证|访问验证)/.test(document.title || "")) return true;
  return Array.from(document.querySelectorAll('iframe[src*="verifycenter"]')).some(frame => {
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  });
})()`;

/** 在现成的抖音页面中直接读取一级评论；各视频互不导航，分页仍串行。 */
export function buildDouyinCommentsExtractJs(options: { awemeIds: string[]; commentLimit: number }) {
  return `
(async () => {
  if (${DOUYIN_VERIFICATION_CHECK_JS}) {
    throw new Error("抖音登录或安全验证未通过，请在 Chrome 完成验证码后重试");
  }
  if (location.origin !== "https://www.douyin.com" || !/^\\/video\\/\\d+/.test(location.pathname)) return { needsSession: true, rows: [] };
  const awemeIds = ${JSON.stringify(options.awemeIds)};
  const commentLimit = ${Math.max(1, Math.min(Math.trunc(options.commentLimit), 200))};
  let lastRequestAt = 0;
  let accessError = "";
  const fetchOne = async (awemeId) => {
    const startedAt = Date.now();
    const deadline = startedAt + 15000;
    const comments = [];
    const seen = new Set();
    let cursor = 0;
    let hasMore = true;
    let pages = 0;
    const pageTrace = [];
    try {
      while (comments.length < commentLimit && hasMore && pages < (commentLimit > 50 ? 20 : 6)) {
        if (accessError) throw new Error("本轮剩余抖音评论请求已暂停：" + accessError);
        if (commentLimit > 50) {
          const wait = Math.max(0, 500 - (Date.now() - lastRequestAt));
          if (wait) await new Promise(resolve => setTimeout(resolve, wait));
          lastRequestAt = Date.now();
        }
        if (Date.now() >= deadline) throw new Error("抖音评论接口超过 15 秒，请重试或缩小采集数量");
        const url = new URL("https://www.douyin.com/aweme/v1/web/comment/list/");
        for (const [key, value] of Object.entries({
          aweme_id: awemeId, cursor: String(cursor), count: String(Math.min(50, commentLimit - comments.length)),
          item_type: "0", insert_ids: "", whale_cut_token: "", cut_version: "1", rcFT: "", device_platform: "webapp", aid: "6383"
        })) url.searchParams.set(key, value);
        const response = await fetch(url.toString(), {
          credentials: "include", headers: { accept: "application/json, text/plain, */*" },
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
        });
        if (!response.ok) {
          const reason = response.status === 429
            ? "抖音请求过于频繁（429），请稍后再试"
            : "抖音评论接口 HTTP " + response.status + "，请在 Chrome 检查登录或验证状态";
          if ([401, 403, 444, 429].includes(response.status)) accessError = reason;
          throw new Error(reason);
        }
        const body = await response.text();
        if (!body.trim()) {
          accessError = "抖音评论接口返回空正文，请在 Chrome 检查登录或验证状态";
          throw new Error(accessError);
        }
        let payload;
        try { payload = JSON.parse(body); }
        catch {
          const reason = "抖音评论接口返回非 JSON 内容，请在 Chrome 检查登录或验证状态";
          if (/^\\s*</.test(body)) accessError = reason;
          throw new Error(reason);
        }
        if (!payload || typeof payload !== "object") throw new Error("抖音评论接口返回无效结果");
        if (Number(payload.status_code || 0) !== 0) {
          throw new Error("抖音评论接口状态 " + payload.status_code + (payload.status_msg ? "：" + payload.status_msg : ""));
        }
        if (!Array.isArray(payload.comments)) throw new Error("抖音评论接口缺少评论列表，请检查网页会话后重试");
        pages += 1;
        const before = comments.length;
        for (const item of payload.comments) {
          const text = String(item?.text || item?.content || "").replace(/\\s+/g, " ").trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          comments.push({ text, likes: Number(item.digg_count || 0), replies: Number(item.reply_comment_total || 0) });
        }
        if (![0, 1, false, true].includes(payload.has_more)) throw new Error("抖音评论分页缺少有效结束标记");
        const nextCursor = Number(payload.cursor ?? 0);
        hasMore = Boolean(payload.has_more);
        if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) throw new Error("抖音评论分页游标无效，采集未完成");
        pageTrace.push({ cursor, nextCursor, returnedCount: payload.comments.length, addedCount: comments.length - before, hasMore });
        if (hasMore && !payload.comments.length) throw new Error("抖音评论返回空页但仍有后续，采集未完成");
        if (hasMore && (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor)) {
          throw new Error("抖音评论分页游标未推进，请重试");
        }
        cursor = nextCursor;
      }
      if (hasMore && comments.length < commentLimit) throw new Error("抖音评论达到分页上限但仍有后续，采集未完成");
      return { awemeId, comments: comments.slice(0, commentLimit), pages, pageTrace, hasMore,
        stopReason: comments.length >= commentLimit ? "target_reached" : "exhausted", ms: Date.now() - startedAt };
    } catch (error) {
      // 失败视频不伪装成成功的部分结果；同批其他视频的成功结果由调用方保留并展示失败原因。
      return { awemeId, comments: [], pages, pageTrace, hasMore, stopReason: "failed", ms: Date.now() - startedAt,
        error: error?.name === "TimeoutError" ? "抖音评论接口超过 15 秒，请重试或缩小采集数量" : String(error?.message || error) };
    }
  };
  const rows = new Array(awemeIds.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(commentLimit > 50 ? 1 : 2, awemeIds.length) }, async () => {
    while (nextIndex < awemeIds.length) {
      const index = nextIndex++;
      rows[index] = await fetchOne(awemeIds[index]);
    }
  }));
  return { needsSession: false, rows };
})()
`;
}

export const DOUYIN_VIDEO_COMMENT_EXTRACT_JS = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const collect = () => {
    const text = String(document.body?.innerText || "");
    const marker = text.indexOf("全部评论");
    const source = marker >= 0 ? text.slice(marker) : text;
    const stopWords = [
      "推荐视频",
      "广告投放",
      "用户服务协议",
      "隐私政策",
      "2026 © 抖音",
      "热门：",
      "加载中"
    ];
    let section = source;
    for (const word of stopWords) {
      const index = section.indexOf(word);
      if (index > 0) section = section.slice(0, index);
    }
    const noise = /^(全部评论|留下你的精彩评论吧|分享|回复|举报|发布时间：|展开\\d+条回复|\\d+(\\.\\d+)?万?|\\d+小时前.*|\\d+分钟前.*|\\d+天前.*|IP属地.*|\\.\\.\\.)$/;
    const lines = section
      .split(/\\n+/)
      .map(clean)
      .filter(Boolean)
      .filter((line) => !noise.test(line));
    const seen = new Set();
    const comments = [];
    let skipSearchHints = false;
    for (const line of lines) {
      if (line === "大家都在搜：") {
        skipSearchHints = true;
        continue;
      }
      if (line === "...") {
        skipSearchHints = false;
        continue;
      }
      if (skipSearchHints) continue;
      if (line.length < 1 || line.length > 240) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      comments.push(line);
    }
    return comments;
  };

  const scrollTargets = Array.from(document.querySelectorAll('[class*="comment"], [id*="comment"], div'))
    .filter((element) => {
      const text = clean(element.innerText || element.textContent || "");
      return text.includes("全部评论") && text.length > 100;
    })
    .sort((a, b) => (a.scrollHeight - a.clientHeight) - (b.scrollHeight - b.clientHeight));
  const target = scrollTargets.find((element) => element.scrollHeight > element.clientHeight + 80) || document.scrollingElement || document.documentElement;
  for (let i = 0; i < 3; i += 1) {
    target.scrollTop += Math.max(500, target.clientHeight || 700);
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(900);
  }
  const replyButtons = Array.from(document.querySelectorAll('button, [role="button"], span'))
    .filter((element) => /^展开\\d+条回复$/.test(clean(element.innerText || element.textContent || "")))
    .slice(0, 5);
  for (const button of replyButtons) {
    button.click();
    await sleep(350);
  }
  return collect().slice(0, 80);
})()
`;

export type DouyinBatchPostExtractAccount = {
  id: string;
  name: string;
  uid: string;
};

export function buildDouyinPostExtractJs(options: {
  secUid: string;
  limit: number;
  fromDate?: string;
  toDate?: string;
}) {
  return buildDouyinPostExtractRuntimeJs({
    accounts: [{ id: "", name: "", uid: options.secUid }],
    concurrency: 1,
    fromDate: options.fromDate,
    limit: options.limit,
    returnRowsOnly: true,
    toDate: options.toDate
  });
}

export const DOUYIN_PROFILE_VIDEO_LINKS_EXTRACT_JS = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const normalizeUrl = (href) => {
    if (!href) return "";
    if (href.startsWith("//")) return "https:" + href;
    if (href.startsWith("/")) return location.origin + href;
    return href;
  };
  const compactNumber = (text) => {
    const match = clean(text).match(/^([0-9.]+)\\s*([万億亿kKmM]?)$/);
    if (!match) return 0;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;
    const unit = String(match[2] || "").toLowerCase();
    if (unit === "万") return Math.round(base * 10000);
    if (unit === "亿" || unit === "億") return Math.round(base * 100000000);
    if (unit === "k") return Math.round(base * 1000);
    if (unit === "m") return Math.round(base * 1000000);
    return Math.round(base);
  };
  const titleFromLines = (lines) => {
    const cleaned = lines.map(clean).filter(Boolean).filter((line) => line !== "置顶");
    const firstMetric = cleaned.findIndex((line) => compactNumber(line) > 0);
    if (firstMetric >= 0 && cleaned[firstMetric + 1]) return cleaned[firstMetric + 1];
    return cleaned.find((line) => /[\\u4e00-\\u9fa5A-Za-z]/.test(line) && !/^\\d/.test(line)) || "";
  };
  const extract = () => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/video/"]'))
      .map((anchor, index) => {
        const href = normalizeUrl(anchor.getAttribute("href") || anchor.href || "");
        const awemeId = href.match(/\\/video\\/(\\d{10,})/)?.[1] || "";
        if (!awemeId || seen.has(awemeId)) return null;
        seen.add(awemeId);
        const lines = String(anchor.innerText || anchor.textContent || "")
          .split(/\\n+/)
          .map(clean)
          .filter(Boolean);
        const likeLine = lines.find((line) => compactNumber(line) > 0) || "";
        const title = titleFromLines(lines);
        return title ? {
          index: index + 1,
          aweme_id: awemeId,
          id: awemeId,
          title,
          desc: title,
          digg_count: compactNumber(likeLine),
          share_url: href,
          web_url: href,
          url: href,
          source: "douyin_profile_dom"
        } : null;
      })
      .filter(Boolean);
  };

  for (let index = 0; index < 4; index += 1) {
    const rows = extract();
    if (rows.length >= 24) return rows;
    window.scrollBy(0, Math.max(600, window.innerHeight || 800));
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(900);
  }
  return extract();
})()
`;

export function buildDouyinVideoPageDomExtractJs(fallback: {
  awemeId: string;
  title: string;
  url: string;
  likes: number;
}) {
  return `
(() => {
  const fallback = ${JSON.stringify(fallback)};
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const compactNumber = (text) => {
    const match = clean(text).match(/^([0-9.]+)\\s*([万億亿kKmM]?)$/);
    if (!match) return 0;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;
    const unit = String(match[2] || "").toLowerCase();
    if (unit === "万") return Math.round(base * 10000);
    if (unit === "亿" || unit === "億") return Math.round(base * 100000000);
    if (unit === "k") return Math.round(base * 1000);
    if (unit === "m") return Math.round(base * 1000000);
    return Math.round(base);
  };
  const toEpochSeconds = (value) => {
    const match = clean(value).match(/(\\d{4})[-/.年](\\d{1,2})[-/.月](\\d{1,2})日?\\s+(\\d{1,2}):(\\d{1,2})/);
    if (!match) return 0;
    const [, year, month, day, hour, minute] = match;
    const time = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0
    ).getTime();
    return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
  };
  const lines = String(document.body?.innerText || "")
    .split(/\\n+/)
    .map(clean)
    .filter(Boolean);
  const fallbackTitle = clean(fallback.title);
  const titleIndex = lines.findIndex((line) => line === fallbackTitle) >= 0
    ? lines.findIndex((line) => line === fallbackTitle)
    : lines.findIndex((line) => /#[^\\s#]+/.test(line) && /[\\u4e00-\\u9fa5A-Za-z]/.test(line));
  const title = titleIndex >= 0 ? lines[titleIndex] : fallbackTitle;
  const metricLines = titleIndex >= 0
    ? lines.slice(titleIndex + 1, titleIndex + 8).filter((line) => compactNumber(line) > 0)
    : [];
  const publishedLine = lines.find((line) => /^发布时间[:：]/.test(line)) || "";
  const createTime = toEpochSeconds(publishedLine);
  return {
    index: 1,
    aweme_id: fallback.awemeId,
    id: fallback.awemeId,
    title: title || fallbackTitle || "未命名视频",
    desc: title || fallbackTitle || "未命名视频",
    create_time: createTime,
    digg_count: metricLines[0] ? compactNumber(metricLines[0]) : Number(fallback.likes || 0),
    comment_count: metricLines[1] ? compactNumber(metricLines[1]) : 0,
    collect_count: metricLines[2] ? compactNumber(metricLines[2]) : 0,
    share_count: metricLines[3] ? compactNumber(metricLines[3]) : 0,
    share_url: fallback.url,
    web_url: fallback.url,
    url: fallback.url,
    source: "douyin_video_page_dom"
  };
})()
`;
}

export function buildDouyinBatchPostExtractJs(options: {
  ranking?: "likes" | "comments";
  pageCursor?: number;
  pageBudget?: number;
  accounts: DouyinBatchPostExtractAccount[];
  concurrency: number;
  limit: number;
  fromDate?: string;
  toDate?: string;
}) {
  return buildDouyinPostExtractRuntimeJs({
    ranking: options.ranking,
    pageCursor: options.pageCursor,
    pageBudget: options.pageBudget,
    accounts: options.accounts,
    concurrency: options.concurrency,
    fromDate: options.fromDate,
    limit: options.limit,
    returnRowsOnly: false,
    toDate: options.toDate
  });
}

function buildDouyinPostExtractRuntimeJs(options: {
  ranking?: "likes" | "comments";
  pageCursor?: number;
  pageBudget?: number;
  accounts: DouyinBatchPostExtractAccount[];
  concurrency: number;
  limit: number;
  fromDate?: string;
  returnRowsOnly: boolean;
  toDate?: string;
}) {
  const fromEpoch = boundaryDateToEpochSeconds(options.fromDate, "start");
  const toEpoch = boundaryDateToEpochSeconds(options.toDate, "end");
  const accounts = options.accounts.map((account) => ({
    id: String(account.id || ""),
    name: String(account.name || ""),
    uid: String(account.uid || "")
  }));
  const concurrency = clampPositiveInteger(options.concurrency, 1);
  const limit = clampPositiveInteger(options.limit, 1);
  const returnStatement = options.returnRowsOnly
    ? `
  const first = await fetchAccount(accounts[0]);
  if (first.status === "completed") return first.rows;
  throw new Error(first.error || "抖音账号抓取失败");`
    : `
  const results = new Array(accounts.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), accounts.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < accounts.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fetchAccount(accounts[currentIndex]);
    }
  }));
  return results;`;

  return `
(async () => {
  const accounts = ${JSON.stringify(accounts)};
  const limit = ${limit};
  const ranking = ${JSON.stringify(options.ranking || "")};
  const resumable = ${Boolean(options.pageBudget)};
  const maxPages = ${options.pageBudget ? clampPositiveInteger(options.pageBudget, 1) : 0} || (ranking ? 500 : 80);
  const concurrency = ${concurrency};
  const fromEpoch = ${fromEpoch ?? "null"};
  const toEpoch = ${toEpoch ?? "null"};
  const pageSize = ${DOUYIN_POST_PAGE_SIZE};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let accessError = "";
  const readUifid = () => {
    const entry = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith("UIFID="));
    return entry ? decodeURIComponent(entry.slice(6)) : "";
  };
  for (let attempt = 0; !readUifid() && attempt < 20; attempt++) await sleep(250);
  if (!readUifid()) throw new Error("抖音网页会话尚未就绪（Uifid 缺失）");
  const toNumber = (value) => {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
  };
  const normalizeUrl = (url) => {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return location.origin + url;
    return url;
  };
  const firstUrl = (value) => {
    if (!value) return "";
    if (typeof value === "string") return normalizeUrl(value);
    if (Array.isArray(value)) return normalizeUrl(String(value[0] || ""));
    if (Array.isArray(value.url_list)) return normalizeUrl(String(value.url_list[0] || ""));
    return "";
  };
  const normalizeItem = (item, index, secUid) => {
    const awemeId = String(item.aweme_id || item.awemeId || item.id || "");
    const stats = item.statistics || {};
    const author = item.author || {};
    return {
      index,
      aweme_id: awemeId,
      id: awemeId,
      title: String(item.desc || item.caption || item.title || "未命名视频"),
      desc: String(item.desc || item.caption || item.title || "未命名视频"),
      duration: toNumber(item.duration || item.video?.duration) ? Math.round(toNumber(item.duration || item.video?.duration) / 1000) : "",
      create_time: toNumber(item.create_time || item.createTime),
      digg_count: toNumber(stats.digg_count ?? item.digg_count),
      comment_count: toNumber(stats.comment_count ?? item.comment_count),
      share_count: toNumber(stats.share_count ?? item.share_count),
      collect_count: toNumber(stats.collect_count ?? item.collect_count),
      play_count: toNumber(stats.play_count ?? item.play_count),
      share_url: item.share_url || (awemeId ? "https://www.douyin.com/video/" + awemeId : ""),
      web_url: awemeId ? "https://www.douyin.com/video/" + awemeId : "",
      url: awemeId ? "https://www.douyin.com/video/" + awemeId : "",
      author_uid: String(author.uid || ""),
      sec_uid: String(author.sec_uid || secUid),
      authorName: String(author.nickname || author.name || author.unique_id || ""),
      avatar_url: firstUrl(author.avatar_thumb || author.avatar_medium || author.avatar_larger),
      video_url: firstUrl(item.video && (item.video.play_addr || item.video.download_addr)),
      raw_statistics: stats,
      source: "douyin_aweme_post_api"
    };
  };

  const fetchPage = async (targetUrl) => {
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (accessError) throw new Error(accessError);
      const url = new URL(targetUrl);
      url.searchParams.set("uifid", readUifid());
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(15000),
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*"
        }
      });
      const text = await response.text();
      if (!response.ok) {
        const message = "aweme/post " + response.status + (text ? ": " + text.slice(0, 120) : "");
        if ([401, 403, 444, 429].includes(response.status)) accessError = message;
        throw new Error(message);
      }
      if (text.trim()) {
        let data;
        try {
          data = JSON.parse(text);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (data) {
          if (data.status_code && Number(data.status_code) !== 0) throw new Error("抖音接口业务错误：" + data.status_code);
          if (!Array.isArray(data.aweme_list)) throw new Error("抖音接口缺少作品列表，未覆盖旧数据");
          return data;
        }
      } else {
        lastError = "empty response";
      }
      await sleep(800 * (attempt + 1));
    }
    throw new Error("aweme/post JSON parse failed: " + lastError);
  };

  const fetchAccount = async (account) => {
    const rows = [];
    const seen = new Set();
    let cursor = ${Number(options.pageCursor) || 0};
    let hasMore = true;
    let page = 0;
    let reachedBeforeFrom = false;

    try {
      while (hasMore && !reachedBeforeFrom && (ranking || rows.length < limit) && page < maxPages) {
        const url = new URL("https://www.douyin.com/aweme/v1/web/aweme/post/");
        url.searchParams.set("sec_user_id", account.uid);
        url.searchParams.set("max_cursor", String(cursor));
        url.searchParams.set("count", String(pageSize));
        url.searchParams.set("aid", "6383");
        const data = await fetchPage(url.toString());
        const list = Array.isArray(data.aweme_list) ? data.aweme_list : [];
        if (!list.length) {
          if (ranking && (data.has_more || data.hasMore)) throw new Error("抖音历史分页返回空页但仍有后续作品，无法完成排序，请重试");
          hasMore = false;
          break;
        }

        for (const item of list) {
          const createTime = toNumber(item.create_time || item.createTime);
          if ((fromEpoch || toEpoch) && !createTime) throw new Error("抖音作品缺少真实发布时间，无法安全筛选日期");
          if (fromEpoch && createTime && createTime < fromEpoch) {
            if (!item.is_top && !item.is_pinned) reachedBeforeFrom = true;
            continue;
          }
          if (toEpoch && createTime && createTime > toEpoch) continue;
          const row = normalizeItem(item, rows.length + 1, account.uid);
          if (!row.aweme_id || seen.has(row.aweme_id)) continue;
          seen.add(row.aweme_id);
          rows.push(row);
          if (!ranking && rows.length >= limit) break;
        }

        const nextCursor = data.max_cursor || data.maxCursor || 0;
        if (ranking && !reachedBeforeFrom && (data.has_more || data.hasMore) && (!nextCursor || String(nextCursor) === String(cursor))) {
          throw new Error("抖音历史分页游标未推进，无法完成排序，请重试");
        }
        cursor = nextCursor;
        hasMore = !reachedBeforeFrom && Boolean(data.has_more || data.hasMore) && Boolean(cursor);
        page += 1;
        if (hasMore && (ranking || rows.length < limit)) await sleep(250);
      }

      if (!resumable && ranking && hasMore && !reachedBeforeFrom) throw new Error("抖音历史作品超过 500 页采集上限，请缩小采集时间范围后重试");
      if (ranking) {
        const key = ranking === "likes" ? "digg_count" : "comment_count";
        rows.sort((a, b) => b[key] - a[key] || b.create_time - a.create_time);
      }
      return {
        accountId: account.id,
        name: account.name,
        uid: account.uid,
        status: "completed",
        rawCount: rows.length,
        nextCursor: hasMore && !reachedBeforeFrom ? cursor : null,
        rows: rows.slice(0, limit)
      };
    } catch (error) {
      return {
        accountId: account.id,
        name: account.name,
        uid: account.uid,
        status: "failed",
        rawCount: 0,
        rows: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };

${returnStatement}
})()
`;
}

export function buildDouyinDetailExtractJs(options: { awemeId: string; commentLimit: number }) {
  return `
(async () => {
  const awemeId = ${JSON.stringify(options.awemeId)};
  const commentLimit = ${options.commentLimit};
  const normalizeText = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const normalizeComment = (comment) => {
    if (!comment || typeof comment !== "object") return null;
    const text = normalizeText(
      comment.text ||
      comment.content ||
      comment.reply_comment?.text ||
      comment.reply_comment?.content ||
      ""
    );
    if (!text) return null;
    return {
      text,
      likes: Number(comment.digg_count || comment.likes || 0),
      replies: Number(comment.reply_comment_total || comment.replies || 0)
    };
  };
  const detailUrl = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
  detailUrl.searchParams.set("aweme_id", awemeId);
  detailUrl.searchParams.set("aid", "6383");
  const detailResponse = await fetch(detailUrl.toString(), {
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*"
    }
  });
  if (!detailResponse.ok) {
    throw new Error("作品详情接口 HTTP " + detailResponse.status);
  }
  const detailPayload = await detailResponse.json().catch(() => ({}));
  if (Number(detailPayload?.status_code || 0) !== 0) {
    throw new Error("作品详情接口状态 " + detailPayload.status_code + (detailPayload.status_msg ? "：" + detailPayload.status_msg : ""));
  }
  const awemeDetail = detailPayload && typeof detailPayload === "object" ? detailPayload.aweme_detail || {} : {};
  const statistics = awemeDetail && typeof awemeDetail === "object" ? awemeDetail.statistics || {} : {};
  let topComments = [];
  let commentCursor = 0;
  let commentHasMore = true;
  let commentPages = 0;
  let commentStatus = 0;
  let commentError = "";
  try {
    while (topComments.length < commentLimit && commentHasMore && commentPages < 6) {
      const pageSize = Math.min(50, commentLimit - topComments.length);
      const commentUrl = new URL("https://www.douyin.com/aweme/v1/web/comment/list/");
      commentUrl.searchParams.set("aweme_id", awemeId);
      commentUrl.searchParams.set("cursor", String(commentCursor));
      commentUrl.searchParams.set("count", String(pageSize));
      commentUrl.searchParams.set("item_type", "0");
      commentUrl.searchParams.set("insert_ids", "");
      commentUrl.searchParams.set("whale_cut_token", "");
      commentUrl.searchParams.set("cut_version", "1");
      commentUrl.searchParams.set("rcFT", "");
      commentUrl.searchParams.set("device_platform", "webapp");
      commentUrl.searchParams.set("aid", "6383");
      const commentResponse = await fetch(commentUrl.toString(), {
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*"
        }
      });
      commentStatus = commentResponse.status;
      if (!commentResponse.ok) {
        throw new Error("评论接口 HTTP " + commentResponse.status);
      }
      const commentPayload = await commentResponse.json().catch(() => ({}));
      if (Number(commentPayload?.status_code || 0) !== 0) {
        throw new Error("评论接口状态 " + commentPayload.status_code + (commentPayload.status_msg ? "：" + commentPayload.status_msg : ""));
      }
      const comments = Array.isArray(commentPayload.comments) ? commentPayload.comments : [];
      topComments.push(...comments.map(normalizeComment).filter(Boolean));
      commentPages += 1;
      const nextCursor = Number(commentPayload.cursor || 0);
      commentHasMore = Boolean(commentPayload.has_more) && nextCursor !== commentCursor && comments.length > 0;
      commentCursor = nextCursor;
    }
  } catch (error) {
    commentError = String(error?.message || error || "评论接口请求失败");
  }
  return {
    title: normalizeText(awemeDetail.desc || awemeDetail.title || ""),
    commentCount: Number(statistics.comment_count || 0),
    likeCount: Number(statistics.digg_count || 0),
    publishedAt: awemeDetail.create_time || awemeDetail.createTime || "",
    topComments: topComments.slice(0, commentLimit),
    commentFetch: {
      status: commentStatus,
      pages: commentPages,
      hasMore: commentHasMore,
      error: commentError
    }
  };
})()
`;
}

export function buildDouyinStatsExtractJs(awemeId: string) {
  return `
(async () => {
  if (location.origin !== "https://www.douyin.com") return { needsSession: true };
  if (${DOUYIN_VERIFICATION_CHECK_JS}) throw new Error("抖音详情核验遇到验证码，请在 Chrome 完成验证后重试。");
  const detailUrl = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
  detailUrl.searchParams.set("aweme_id", ${JSON.stringify(awemeId)});
  detailUrl.searchParams.set("aid", "6383");
  const response = await fetch(detailUrl.toString(), {
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*"
    }
  });
  if (!response.ok) throw new Error("抖音详情接口请求失败（HTTP " + response.status + "），请在浏览器中打开抖音并确认登录或验证状态。");
  const payload = await response.json().catch(() => { throw new Error("抖音详情接口返回非 JSON 内容，请检查抖音网页会话。"); });
  if (payload?.status_code) throw new Error("抖音详情接口返回错误 " + payload.status_code + "：" + (payload.status_msg || "请检查抖音网页会话"));
  const awemeDetail = payload && typeof payload === "object" ? payload.aweme_detail || {} : {};
  const statistics = awemeDetail && typeof awemeDetail === "object" ? awemeDetail.statistics || {} : {};
  const hasStats = Boolean(statistics && typeof statistics === "object" && Object.keys(statistics).length);
  return {
    hasStats,
    missingFields: ["digg_count", "comment_count", "collect_count", "share_count"].filter((key) => statistics[key] == null || statistics[key] === "" || !Number.isFinite(Number(statistics[key])) || Number(statistics[key]) < 0),
    title: awemeDetail.desc || awemeDetail.title || "",
    likeCount: Number(statistics.digg_count || 0),
    commentCount: Number(statistics.comment_count || 0),
    favoriteCount: Number(statistics.collect_count || 0),
    shareCount: Number(statistics.share_count || 0),
    publishedAt: awemeDetail.create_time || awemeDetail.createTime || "",
    authorName: (awemeDetail.author && (awemeDetail.author.nickname || awemeDetail.author.name || awemeDetail.author.unique_id)) || "",
    authorSecUid: (awemeDetail.author && (awemeDetail.author.sec_uid || awemeDetail.author.secUid || awemeDetail.author.sec_user_id)) || ""
  };
})()
`;
}

/** 评论来源门槛的批量核验；判定与 buildDouyinStatsExtractJs 一致，单条失败不影响同批其他作品。 */
export function buildDouyinCommentCountsJs(awemeIds: string[]) {
  return `
(async () => {
  if (location.origin !== "https://www.douyin.com") return { needsSession: true };
  if (${DOUYIN_VERIFICATION_CHECK_JS}) throw new Error("抖音详情核验遇到验证码，请在 Chrome 完成验证后重试。");
  const awemeIds = ${JSON.stringify(awemeIds)};
  const fetchOne = async (awemeId) => {
    const detailUrl = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
    detailUrl.searchParams.set("aweme_id", awemeId);
    detailUrl.searchParams.set("aid", "6383");
    const response = await fetch(detailUrl.toString(), { credentials: "include", headers: { accept: "application/json, text/plain, */*" } });
    if (!response.ok) throw new Error("抖音详情接口请求失败（HTTP " + response.status + "），请在浏览器中打开抖音并确认登录或验证状态。");
    const payload = await response.json().catch(() => { throw new Error("抖音详情接口返回非 JSON 内容，请检查抖音网页会话。"); });
    if (payload?.status_code) throw new Error("抖音详情接口返回错误 " + payload.status_code + "：" + (payload.status_msg || "请检查抖音网页会话"));
    const awemeDetail = payload && typeof payload === "object" ? payload.aweme_detail || {} : {};
    const statistics = awemeDetail && typeof awemeDetail === "object" ? awemeDetail.statistics || {} : {};
    const hasStats = Boolean(statistics && typeof statistics === "object" && Object.keys(statistics).length);
    return { awemeId, hasStats, commentCount: Number(statistics.comment_count || 0) };
  };
  const rows = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, awemeIds.length) }, async () => {
    while (cursor < awemeIds.length) {
      const index = cursor++;
      try {
        rows[index] = await fetchOne(awemeIds[index]);
      } catch (error) {
        rows[index] = { awemeId: awemeIds[index], error: String(error?.message || error) };
      }
    }
  }));
  return { rows };
})()
`;
}

export function buildDouyinBatchStatsExtractJs(awemeIds: string[]) {
  return `
(async () => {
  const awemeIds = ${JSON.stringify(awemeIds)};
  const fetchOne = async (awemeId) => {
    const detailUrl = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
    detailUrl.searchParams.set("aweme_id", awemeId);
    detailUrl.searchParams.set("aid", "6383");
    const response = await fetch(detailUrl.toString(), {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*"
      }
    });
    if (!response.ok) throw new Error("抖音详情接口请求失败（HTTP " + response.status + "），请在浏览器中打开抖音并确认登录或验证状态。");
    const payload = await response.json().catch(() => { throw new Error("抖音详情接口返回非 JSON 内容，请检查抖音网页会话。"); });
    if (payload?.status_code) throw new Error("抖音详情接口返回错误 " + payload.status_code + "：" + (payload.status_msg || "请检查抖音网页会话"));
    const awemeDetail = payload && typeof payload === "object" ? payload.aweme_detail || {} : {};
    const statistics = awemeDetail && typeof awemeDetail === "object" ? awemeDetail.statistics || {} : {};
    const hasStats = Boolean(statistics && typeof statistics === "object" && Object.keys(statistics).length);
    return {
      awemeId,
      hasStats: hasStats && !["digg_count", "comment_count", "collect_count", "share_count"].some((key) => statistics[key] == null),
      missingFields: ["digg_count", "comment_count", "collect_count", "share_count"].filter((key) => statistics[key] == null || statistics[key] === "" || !Number.isFinite(Number(statistics[key])) || Number(statistics[key]) < 0),
      title: awemeDetail.desc || awemeDetail.title || "",
      likeCount: Number(statistics.digg_count || 0),
      commentCount: Number(statistics.comment_count || 0),
      favoriteCount: Number(statistics.collect_count || 0),
      shareCount: Number(statistics.share_count || 0),
      publishedAt: awemeDetail.create_time || awemeDetail.createTime || "",
      authorName: (awemeDetail.author && (awemeDetail.author.nickname || awemeDetail.author.name || awemeDetail.author.unique_id)) || "",
      authorSecUid: (awemeDetail.author && (awemeDetail.author.sec_uid || awemeDetail.author.secUid || awemeDetail.author.sec_user_id)) || ""
    };
  };
  const results = [];
  const concurrency = 6;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, awemeIds.length) }, async () => {
    while (cursor < awemeIds.length) {
      const index = cursor++;
      try {
        results[index] = await fetchOne(awemeIds[index]);
      } catch (error) {
        results[index] = { awemeId: awemeIds[index], hasStats: false, error: "抖音详情补全失败：" + String(error?.message || error) };
      }
    }
  }));
  return results;
})()
`;
}

export const DOUYIN_AWEME_ID_EXTRACT_JS = `
(() => {
  const candidates = [location.href];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const href = anchor.href || anchor.getAttribute("href") || "";
    if (href) candidates.push(href);
  }
  for (const entry of performance.getEntriesByType("resource")) {
    if (entry.name) candidates.push(entry.name);
  }
  const html = document.documentElement?.innerHTML || "";
  const textMatches = html.match(/(?:\\/video\\/|aweme_id["'=:\\s]+)(\\d{10,})/g) || [];
  candidates.push(...textMatches);

  const extract = (value) => {
    const text = String(value || "");
    return (
      text.match(/\\/video\\/(\\d{10,})/)?.[1] ||
      text.match(/[?&]aweme_id=(\\d{10,})/)?.[1] ||
      text.match(/aweme_id["'=:\\s]+(\\d{10,})/)?.[1] ||
      text.match(/awemeId["'=:\\s]+(\\d{10,})/)?.[1] ||
      ""
    );
  };
  const awemeId = candidates.map(extract).find(Boolean) || "";
  return {
    awemeId,
    url: awemeId ? "https://www.douyin.com/video/" + awemeId : location.href
  };
})()
`;

export const DOUYIN_MEDIA_EXTRACT_JS = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const collect = () => {
    const urls = [];
    for (const video of Array.from(document.querySelectorAll("video"))) {
      for (const value of [video.currentSrc, video.src]) {
        if (value) urls.push(value);
      }
      for (const source of Array.from(video.querySelectorAll("source"))) {
        const value = source.src || source.getAttribute("src") || "";
        if (value) urls.push(value);
      }
    }
    for (const entry of performance.getEntriesByType("resource")) {
      const name = entry.name || "";
      if (/douyinvod|mime_type=video|\\/aweme\\/v1\\/play\\//i.test(name)) urls.push(name);
    }
    return Array.from(new Set(urls)).filter((url) => /^https?:\\/\\//i.test(url));
  };

  for (let i = 0; i < 8; i += 1) {
    const urls = collect();
    if (urls.length) return urls;
    const video = document.querySelector("video");
    if (video) video.play().catch(() => undefined);
    await sleep(1000);
  }
  return collect();
})()
`;

function boundaryDateToEpochSeconds(value: string | undefined, boundary: "start" | "end") {
  if (!value) return null;
  const date = new Date(`${value}T${boundary === "start" ? "00:00:00" : "23:59:59"}+08:00`);
  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

function clampPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
