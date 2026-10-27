import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildCommentBenchmarkPageJs, buildCommentBenchmarkBatchJs, createBufferedCommentPageFetcher, measureAllCommentPages } from "../scripts/lib/douyin-comment-benchmark";

test("全量计时翻过 6 页，并按 ID 去重；一级评论和楼中楼都必须翻到底", async () => {
  const calls: Array<{ cursor: string; parentId?: string }> = [];
  const result = await measureAllCommentPages(async (cursor, parentId) => {
    calls.push({ cursor, parentId });
    if (parentId) return { cursor: "1", hasMore: cursor === "0", comments: [{ id: cursor === "0" ? "reply-1" : "reply-2", replies: 0 }] };
    const page = Number(cursor);
    return { cursor: String(page + 1), hasMore: page < 7, comments: [{ id: `comment-${page}`, replies: page === 0 ? 2 : 0 }] };
  });
  assert.equal(result.topLevelCount, 8);
  assert.equal(result.replyCount, 2);
  assert.equal(result.pageCount, 10);
  assert.equal(result.accessiblePagesExhausted, true);
  assert.equal(calls.at(-1)?.parentId, "comment-0");
});

test("分页异常或取消不能返回全量完成", async () => {
  await assert.rejects(measureAllCommentPages(async () => ({ cursor: "0", hasMore: true, comments: [{ id: "same", replies: 0 }] })), /游标重复/);
  await assert.rejects(measureAllCommentPages(async () => ({ cursor: "1", hasMore: true, comments: [] })), /空评论页/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(measureAllCommentPages(async () => { throw new Error("不应发出请求"); }, undefined, controller.signal), { name: "AbortError" });
});

test("楼中楼请求使用评论 ID 和视频 ID，返回真实分页信息", async () => {
  const result = await vm.runInNewContext(buildCommentBenchmarkPageJs("video", "50", "parent"), {
    URL, AbortSignal, performance, document: { title: "抖音", querySelectorAll: () => [] },
    fetch: async (url: string) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/aweme/v1/web/comment/list/reply/");
      assert.equal(parsed.searchParams.get("item_id"), "video");
      assert.equal(parsed.searchParams.get("comment_id"), "parent");
      assert.equal(parsed.searchParams.get("cursor"), "50");
      return { ok: true, text: async () => JSON.stringify({ cursor: 100, has_more: 0, comments: [{ cid: "123", text: "相同正文也按 ID 保留", digg_count: 7, create_time: 1234, user: { nickname: "作者" }, reply_comment_total: 0 }] }) };
    }
  });
  assert.equal(result.cursor, "100");
  assert.equal(result.hasMore, false);
  assert.equal(result.comments[0].id, "123");
  assert.equal(result.comments[0].text, "相同正文也按 ID 保留");
  assert.equal(result.comments[0].likes, 7);
  assert.equal(result.comments[0].author, "作者");
});

test("明确结束的空回复页可翻完，缺字段或仍有后续的空结果不能伪装完成", async () => {
  const context = (payload: unknown) => ({
    URL, AbortSignal, performance, document: { title: "抖音", querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(payload) })
  });
  const js = buildCommentBenchmarkPageJs("video", "0", "parent");
  const page = await vm.runInNewContext(js, context({ status_code: 0, comments: null, cursor: 50, has_more: 0, total: 1 }));
  assert.equal(page.comments.length, 0);
  assert.equal(page.hasMore, false);
  for (const payload of [
    { comments: null, cursor: 50, has_more: 1 }, { comments: null, cursor: 50 },
    { comments: [], cursor: 50, has_more: "0" }, { cursor: 50, has_more: 0 }
  ]) await assert.rejects(vm.runInNewContext(js, context(payload)), /缺少/);
});

test("一批连续翻五页，按上游游标推进且 pageSize 不得超过 50", async () => {
  const cursors: string[] = [];
  const rows = await vm.runInNewContext(buildCommentBenchmarkBatchJs("video", [{ cursor: "0" }], { intervalMs: 0, pageSize: 200 }), {
    URL, AbortSignal, performance, document: { title: "抖音", querySelectorAll: () => [] },
    fetch: async (url: string) => {
      const parsed = new URL(url);
      const cursor = parsed.searchParams.get("cursor")!;
      cursors.push(cursor);
      assert.equal(parsed.searchParams.get("count"), "50");
      return { ok: true, text: async () => JSON.stringify({ cursor: Number(cursor) + 50, has_more: 1, comments: [{ cid: cursor }] }) };
    }
  });
  assert.deepEqual(cursors, ["0", "50", "100", "150", "200"]);
  assert.equal(rows[0].pages.length, 5);
  assert.equal(rows[0].error, undefined);
});

test("批量中途失败保留此前成功的页，下一游标失败且不自动重试", async () => {
  let batchCalls = 0;
  const fetchPage = createBufferedCommentPageFetcher(async requests => {
    batchCalls++;
    return vm.runInNewContext(buildCommentBenchmarkBatchJs("video", requests, { intervalMs: 0 }), {
      URL, AbortSignal, performance, document: { title: "抖音", querySelectorAll: () => [] },
      fetch: async (url: string) => {
        const cursor = Number(new URL(url).searchParams.get("cursor"));
        return cursor === 100 ? { ok: false, status: 429 } : {
          ok: true, text: async () => JSON.stringify({ cursor: cursor + 50, has_more: 1, comments: [{ cid: String(cursor) }] })
        };
      }
    });
  });
  assert.equal((await fetchPage("0")).comments[0].id, "0");
  assert.equal((await fetchPage("50")).comments[0].id, "50");
  await assert.rejects(fetchPage("100"), /HTTP 429/);
  assert.equal(batchCalls, 1);
});

test("两个楼中楼请求合为一个调用，各自结束且互不混入评论", async () => {
  let batchCalls = 0;
  const fetchPage = createBufferedCommentPageFetcher(async requests => {
    batchCalls++;
    assert.equal(requests.length, 2);
    return requests.map(request => ({ pages: [{ requestCursor: request.cursor, page: {
      cursor: "50", hasMore: false, comments: [{ id: request.parentId!, replies: 0 }]
    } }] }));
  });
  const [a, b] = await Promise.all([fetchPage("0", "a"), fetchPage("0", "b")]);
  assert.equal(a.comments[0].id, "a");
  assert.equal(b.comments[0].id, "b");
  assert.equal(batchCalls, 1);
});

test("楼中楼最多并发两个；正文逐页交付并明确记录上游未返回的回复", async () => {
  let active = 0;
  let peak = 0;
  const saved: Array<{ id: string; parentId?: string }> = [];
  const result = await measureAllCommentPages(async (_cursor, parentId) => {
    if (!parentId) return { cursor: "50", hasMore: false, comments: ["a", "b", "c"].map(id => ({ id, replies: 2 })) };
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { cursor: "50", hasMore: false, comments: parentId === "c" ? [] : [{ id: `${parentId}-reply`, replies: 0, text: "正文" }] };
  }, undefined, undefined, { replyConcurrency: 2, onPage: async (page, parentId) => {
    saved.push(...page.comments.map(comment => ({ id: comment.id, parentId })));
  } });
  assert.equal(peak, 2);
  assert.equal(saved.length, 5);
  assert.equal(result.replyCount, 2);
  assert.equal(result.unavailableReplyCount, 4);
  assert.equal(result.parentsWithUnavailableReplies, 3);
});
