import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDouyinCommentsExtractJs, DOUYIN_VERIFICATION_CHECK_JS } from "../src/lib/opencli-douyin-scripts";
import { getDouyinComments, getDouyinRelatedTopicComments } from "../src/lib/opencli";

function run(
  fetch: (url: string, options: RequestInit) => Promise<unknown>,
  awemeIds = ["1"],
  commentLimit = 12,
  location = { origin: "https://www.douyin.com", pathname: "/video/1" }
) {
  return vm.runInNewContext(buildDouyinCommentsExtractJs({ awemeIds, commentLimit }), {
    URL, AbortSignal, location, fetch, document: { title: "抖音", querySelectorAll: () => [] }
  });
}

const response = (payload: unknown) => ({ ok: true, text: async () => JSON.stringify(payload) });

test("直接按视频 ID 读取评论，不请求详情且保留浏览器认证和请求超时", async () => {
  const result = await run(async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/aweme/v1/web/comment/list/");
    assert.equal(parsed.searchParams.get("aweme_id"), "1");
    assert.equal(parsed.searchParams.get("count"), "12");
    assert.equal(options.credentials, "include");
    assert.ok(options.signal instanceof AbortSignal);
    return response({ comments: [{ text: " 真 实\n评论 ", digg_count: 7, reply_comment_total: 2 }], cursor: 1, has_more: 0 });
  });
  assert.equal(result.rows[0].comments[0].text, "真 实 评论");
  assert.equal(result.rows[0].comments[0].likes, 7);
  assert.equal(result.rows[0].comments[0].replies, 2);
});

test("同视频分页串行、去重并补足数量，游标正确推进", async () => {
  const cursors: string[] = [];
  const result = await run(async (url) => {
    cursors.push(new URL(url).searchParams.get("cursor")!);
    return response(cursors.length === 1
      ? { comments: [{ text: "第一条" }, { text: "第一条" }], cursor: 10, has_more: 1 }
      : { comments: [{ text: "第一条" }, { text: "第二条" }], cursor: 20, has_more: 0 });
  }, ["1"], 2);
  assert.deepEqual(cursors, ["0", "10"]);
  assert.equal(result.rows[0].comments.length, 2);
  assert.equal(result.rows[0].pages, 2);
});

test("不同视频最多并发 2 个，结果按输入顺序返回", async () => {
  let active = 0;
  let peak = 0;
  const result = await run(async (url) => {
    active++;
    peak = Math.max(peak, active);
    const id = new URL(url).searchParams.get("aweme_id");
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return response({ comments: [{ text: id }], has_more: 0 });
  }, ["1", "2", "3", "4"]);
  assert.equal(peak, 2);
  assert.equal(result.rows.map((row: { awemeId: string }) => row.awemeId).join(","), "1,2,3,4");
});

test("空正文、非 JSON、缺字段和业务错误均显式失败", async () => {
  for (const [body, expected] of [
    ["", /空正文/], ["<html>verify</html>", /非 JSON/], ["null", /无效结果/], ["{}", /缺少评论列表/],
    [JSON.stringify({ status_code: 8, status_msg: "登录失效" }), /8：登录失效/]
  ] as const) {
    const result = await run(async () => ({ ok: true, text: async () => body }));
    assert.match(result.rows[0].error, expected);
    assert.equal(result.rows[0].comments.length, 0);
  }
});

test("访问受限时停止发出后续视频请求，保留同批成功结果", async () => {
  for (const status of [401, 403, 444, 429]) {
    const requests: string[] = [];
    const result = await run(async (url) => {
      const id = new URL(url).searchParams.get("aweme_id")!;
      requests.push(id);
      return id === "1" ? { ok: false, status } : response({ comments: [{ text: "成功" }], has_more: 0 });
    }, ["1", "2", "3", "4"]);
    assert.equal(requests.join(","), "1,2");
    assert.match(result.rows[0].error, new RegExp(String(status)));
    assert.equal(result.rows[1].comments.length, 1);
    assert.match(result.rows[2].error, /已暂停/);
    assert.match(result.rows[3].error, /已暂停/);
  }
});

test("分页失败不可伪装成成功的部分评论", async () => {
  let requests = 0;
  const result = await run(async () => ++requests === 1
    ? response({ comments: [{ text: "成功第一页" }], cursor: 1, has_more: 1 })
    : { ok: false, status: 500 });
  assert.match(result.rows[0].error, /HTTP 500/);
  assert.equal(result.rows[0].comments.length, 0);
});

test("分页游标不推进时显式失败，不能重复取同一页", async () => {
  const result = await run(async () => response({ comments: [{ text: "评论" }], cursor: 0, has_more: 1 }));
  assert.match(result.rows[0].error, /游标未推进/);
});

test("空页仍有后续、缺结束标记和分页上限都显式失败，保留分页诊断", async () => {
  for (const payload of [
    { comments: [], cursor: 1, has_more: 1 },
    { comments: [], cursor: 0 }
  ]) {
    const result = await run(async () => response(payload));
    assert.match(result.rows[0].error, /空页|结束标记/);
    assert.equal(result.rows[0].stopReason, "failed");
  }
  let page = 0;
  const limited = await run(async () => response({ comments: [{ text: "评论" + ++page }], cursor: page, has_more: 1 }));
  assert.match(limited.rows[0].error, /分页上限/);
  assert.equal(limited.rows[0].pageTrace.length, 6);
  assert.equal(limited.rows[0].comments.length, 0);
  const ended = await run(async () => response({ comments: [{ text: "唯一原评" }], cursor: 1, has_more: 0 }));
  assert.equal(ended.rows[0].stopReason, "exhausted");
  assert.equal(ended.rows[0].pageTrace[0].returnedCount, 1);
  assert.equal(ended.rows[0].pageTrace[0].nextCursor, 1);
});

test("非作品页只请求会话初始化，不发送评论请求", async () => {
  for (const location of [
    { origin: "null", pathname: "blank" },
    { origin: "https://www.douyin.com", pathname: "/search/test" }
  ]) {
    const result = await run(async () => { throw new Error("不应发送请求"); }, ["1"], 12, location);
    assert.equal(result.needsSession, true);
  }
});

test("验证码页立即失败，不发送评论请求或自动重试验证码", async () => {
  await assert.rejects(vm.runInNewContext(buildDouyinCommentsExtractJs({ awemeIds: ["1"], commentLimit: 12 }), {
    document: { title: "验证码中间页", querySelector: () => null },
    fetch: async () => { throw new Error("不应发送请求"); }
  }), /完成验证码/);
});

test("常驻隐藏的验证 iframe 不拦截评论，真正显示的验证窗口才拦截", () => {
  const frame = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const context = {
    document: { title: "挑战用手机拍照片 - 抖音", querySelectorAll: () => [frame] },
    getComputedStyle: () => ({ display: "none", visibility: "visible", opacity: "1" })
  };
  assert.equal(vm.runInNewContext(DOUYIN_VERIFICATION_CHECK_JS, context), false);
  frame.getBoundingClientRect = () => ({ width: 400, height: 300 });
  context.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  assert.equal(vm.runInNewContext(DOUYIN_VERIFICATION_CHECK_JS, context), true);
});

async function withFakeCli(runTest: (events: () => Promise<string[]>) => Promise<void>, cold = false, unknownCounts = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-comments-test-"));
  const fixture = path.join(dir, "cli.mjs");
  const eventFile = path.join(dir, "events.ndjson");
  const stateFile = path.join(dir, "ready");
  await fs.writeFile(fixture, `
import fs from "node:fs";
import vm from "node:vm";
const args = process.argv.slice(2);
const event = (value) => fs.appendFileSync(${JSON.stringify(eventFile)}, value + "\\n");
if (args[0] === "douyin") {
  event("search");
  console.log(JSON.stringify([
    { id: "1111111111111111111", desc: "小米17 手机评测", likes: 100000, comment_count: ${unknownCounts ? "undefined" : "300"} },
    { id: "2222222222222222222", desc: "小米17 手机体验", likes: 90000, comment_count: ${unknownCounts ? "undefined" : "400"} }
  ]));
} else if (args.includes("open")) {
  event("open");
  fs.writeFileSync(${JSON.stringify(stateFile)}, "ready");
  console.log(JSON.stringify({ page: "page-1" }));
} else {
  event("eval");
  const result = await vm.runInNewContext(args.at(-1), {
    URL, AbortSignal,
    location: { origin: fs.existsSync(${JSON.stringify(stateFile)}) ? "https://www.douyin.com" : "null", pathname: "/video/1111111111111111111" },
    document: { title: "抖音", querySelectorAll: () => [] },
    fetch: async (url) => {
      const parsed = new URL(url);
      event(parsed.pathname);
      if (parsed.pathname.endsWith("/aweme/detail/")) return { ok: true, json: async () => ({ aweme_detail: { statistics: { comment_count: 300 } } }) };
      return parsed.searchParams.get("aweme_id") === "2222222222222222222"
        ? { ok: false, status: 500 }
        : { ok: true, text: async () => JSON.stringify({ comments: [{ text: "小米17 评论", digg_count: 9 }], has_more: 0 }) };
    }
  });
  console.log(JSON.stringify(result));
}
`);
  if (!cold) await fs.writeFile(stateFile, "ready");
  const previous = { script: process.env.OPENCLI_SCRIPT, session: process.env.OPENCLI_BROWSER_SESSION };
  process.env.OPENCLI_SCRIPT = fixture;
  process.env.OPENCLI_BROWSER_SESSION = path.basename(dir);
  try {
    await runTest(async () => (await fs.readFile(eventFile, "utf8")).trim().split("\n"));
  } finally {
    if (previous.script === undefined) delete process.env.OPENCLI_SCRIPT;
    else process.env.OPENCLI_SCRIPT = previous.script;
    if (previous.session === undefined) delete process.env.OPENCLI_BROWSER_SESSION;
    else process.env.OPENCLI_BROWSER_SESSION = previous.session;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("直接入口冷启动只初始化一次，后续调用复用会话且不搜索或读取详情", async () => {
  await withFakeCli(async (events) => {
    const video = { id: "1111111111111111111", url: "" };
    for (let i = 0; i < 2; i++) {
      const rows = await getDouyinComments(video, 12);
      assert.equal(rows[0].text, "小米17 评论");
    }
    const calls = await events();
    assert.equal(calls.filter((call) => call === "open").length, 1);
    assert.equal(calls.filter((call) => call === "/aweme/v1/web/comment/list/").length, 2);
    assert.equal(calls.includes("search"), false);
    assert.equal(calls.some((call) => call.includes("detail")), false);
  }, true);
});

test("调研入口保留成功评论并传递每个失败视频的原因", async () => {
  await withFakeCli(async (events) => {
    const result = await getDouyinRelatedTopicComments("小米17", { videoLimit: 2, commentLimit: 12 });
    assert.equal(result.commentSamples.length, 1);
    assert.match(result.errors![0], /2222222222222222222.*HTTP 500/);
    const calls = await events();
    assert.equal(calls.filter((call) => call === "eval").length, 2);
    assert.equal(calls.includes("open"), false);
  });
});

test("直接入口拒绝错误 ID，取消后的请求不进入浏览器队列", async () => {
  await assert.rejects(getDouyinComments({ id: "invalid", url: "" }), /没有识别到抖音视频 ID/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getDouyinComments({ id: "1111111111111111111", url: "" }, 12, { signal: controller.signal }), { name: "AbortError" });
});


test("调研详情核验冷启动先初始化抖音会话，后续视频复用页面", async () => {
  await withFakeCli(async (events) => {
    const result = await getDouyinRelatedTopicComments("小米17", { videoLimit: 2, commentLimit: 12 });
    assert.equal(result.videos[0].commentCount, 300);
    assert.equal(result.commentSamples.length, 1);
    const calls = await events();
    assert.equal(calls.filter(call => call === "open").length, 1);
    assert.ok(calls.indexOf("open") < calls.indexOf("/aweme/v1/web/aweme/detail/"));
    assert.equal(calls.filter(call => call === "/aweme/v1/web/aweme/detail/").length, 2);
  }, true, true);
});
