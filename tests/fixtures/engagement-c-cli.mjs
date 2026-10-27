import fs from "node:fs";
import vm from "node:vm";
const args = process.argv.slice(2);
const emit = (data) => console.log(JSON.stringify({ ok: true, data }));
const events = process.env.COMMENT_TEST_EVENTS;
const threshold = process.env.COMMENT_TEST_CORPUS === "threshold";
const sparse = process.env.COMMENT_TEST_CORPUS === "sparse";
const record = (row) => { if (events) fs.appendFileSync(events, JSON.stringify(row) + "\n"); };
if (args[0] === "douyin" || args[0] === "bilibili") {
  record({ kind: "search", platform: args[0], query: args[2] });
  emit(sparse || threshold ? Array.from({ length: 4 }, (_, i) => args[0] === "douyin"
    ? { id: String(i + 1).repeat(19), desc: "折叠手机来源" + i, author: "作者" + i, likes: 1000 - i }
    : { bvid: "BV" + (i + 1) + "xx411c7mD", title: "折叠手机来源" + i, author: "作者" + i, plays: 1000 - i }) : args[0] === "douyin"
    ? [{ id: "1111111111111111111", desc: "折叠手机体验", likes: 100000 }]
    : [{ bvid: "BV1xx411c7mD", title: "折叠手机体验", plays: 200000 }] );
} else if (args.includes("open")) {
  emit({ page: "fixture" });
} else {
  const bilibili = args[args.indexOf("--session") + 1].endsWith("-bilibili-comments");
  const result = await vm.runInNewContext(args.at(-1), {
    URL, AbortSignal, setTimeout,
    location: { hostname: bilibili ? "www.bilibili.com" : "www.douyin.com", origin: bilibili ? "https://www.bilibili.com" : "https://www.douyin.com", pathname: "/video/1111111111111111111" },
    document: { title: "作品页", querySelectorAll: () => [] },
    fetch: async (value) => {
      const url = new URL(value); record({ kind: "api", platform: bilibili ? "bilibili" : "douyin", path: url.pathname, next: url.searchParams.get("next") || url.searchParams.get("cursor"), video: url.searchParams.get("oid") || url.searchParams.get("aweme_id") });
      if (process.env.COMMENT_TEST_FAIL_PLATFORM === (bilibili ? "bilibili" : "douyin")) return { ok: false, status: 403 };
      let payload;
      if (url.pathname.endsWith("/nav")) payload = { code: 0, data: { isLogin: true, wbi_img: { img_url: "https://i.example/" + "a".repeat(32) + ".png", sub_url: "https://i.example/" + "b".repeat(32) + ".png" } } };
      else if (url.pathname.endsWith("/view")) payload = { code: 0, data: { aid: sparse ? Number(url.searchParams.get("bvid")[2]) : 123, stat: threshold ? (url.searchParams.get("bvid")[2] === "1" ? { reply: 200 } : url.searchParams.get("bvid")[2] === "2" ? { reply: 201 } : {}) : { reply: 300 } } };
      else if (url.pathname === "/aweme/v1/web/aweme/detail/") payload = { aweme_detail: { statistics: threshold ? (url.searchParams.get("aweme_id")[0] === "1" ? { comment_count: 200 } : url.searchParams.get("aweme_id")[0] === "2" ? { comment_count: 201 } : {}) : { comment_count: 300 } } };
      else if (bilibili) {
        const next = Number(url.searchParams.get("next"));
        payload = { code: 0, data: { cursor: { next: next + 1, is_end: next === 3 }, replies: Array.from({ length: 50 }, (_, i) => ({ rpid_str: String(next * 50 + i + 1), content: { message: "B站参考句子" + (next * 50 + i) }, like: i, rcount: 0 })) } };
        payload.data.top_replies = [{ rpid_str: "1", content: { message: "B站参考句子0" } }];
        if (next) payload.data.replies.unshift({ rpid_str: String(next * 50), content: { message: "重复上一页" } });
        if (process.env.COMMENT_TEST_BILI_MODE === "stuck") payload.data.cursor.next = 0;
      } else {
        const cursor = Number(url.searchParams.get("cursor"));
        payload = { comments: Array.from({ length: 50 }, (_, i) => ({ text: "抖音参考句子" + (cursor + i), digg_count: i })), cursor: cursor + 50, has_more: cursor < 150 ? 1 : 0 };
      }
      if (sparse && url.pathname === "/x/v2/reply/wbi/main") {
        const id = Number(url.searchParams.get("oid")), next = Number(url.searchParams.get("next"));
        const total = id <= 2 ? id + 1 : 200;
        payload = { code: 0, data: { cursor: { next: next + 1, is_end: (next + 1) * 50 >= total }, replies: Array.from({ length: Math.min(50, total - next * 50) }, (_, i) => ({ rpid_str: String(next * 50 + i + 1), content: { message: "B站来源" + id + "的原评" + (next * 50 + i) }, like: i })) } };
      } else if (sparse && url.pathname === "/aweme/v1/web/comment/list/") {
        const id = Number(url.searchParams.get("aweme_id")[0]), cursor = Number(url.searchParams.get("cursor"));
        const total = id <= 2 ? id + 1 : 200;
        payload = { comments: Array.from({ length: Math.min(50, total - cursor) }, (_, i) => ({ text: "抖音来源" + id + "的原评" + (cursor + i) })), cursor: cursor + 50, has_more: cursor + 50 < total ? 1 : 0 };
      }
      return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
  });
  emit(result);
}
