import assert from "node:assert/strict";
import test from "node:test";
import { cookieHeaderForCommentUrl, parseHttpCommentPage, selectCommentRequest } from "../scripts/lib/douyin-comment-http";

test("签名请求只选当前视频的 HTTPS 抖音评论接口，不接受异站或另一视频的捕获", () => {
  const url = "https://www-hj.douyin.com/aweme/v1/web/comment/list/?aweme_id=video&cursor=0";
  const valid = { url, method: "GET", requestHeaders: {} };
  assert.equal(selectCommentRequest([
    valid, { ...valid, url: url.replace("www-hj.douyin.com", "www-hj.douyin.com.attacker.test") },
    { ...valid, url: url.replace("aweme_id=video", "aweme_id=another") }, { ...valid, method: "POST" },
    { ...valid, url: url.replace("https:", "http:") }
  ], "video"), valid);
  assert.throws(() => selectCommentRequest([{ ...valid, url: url.replace("aweme_id=video", "aweme_id=another") }], "video"), /没有捕获/);
  const reply = { ...valid, url: "https://www-hj.douyin.com/aweme/v1/web/comment/list/reply/?item_id=video&comment_id=parent&cursor=0" };
  assert.equal(selectCommentRequest([reply], "video", "parent"), reply);
  assert.throws(() => selectCommentRequest([reply], "video", "other-parent"), /没有捕获/);
});

test("HTTP Cookie 严格遵守域名、路径与过期时间，不把其他站点的凭据发给评论接口", () => {
  const header = cookieHeaderForCommentUrl([
    { name: "shared", value: "yes", domain: ".douyin.com", path: "/", secure: true },
    { name: "exact", value: "yes", domain: "www-hj.douyin.com", path: "/aweme" },
    { name: "otherHost", value: "no", domain: "www.douyin.com" },
    { name: "otherSite", value: "no", domain: ".example.com" },
    { name: "wrongPath", value: "no", domain: ".douyin.com", path: "/aweme/v1/web/comment/listing" },
    { name: "expired", value: "no", domain: ".douyin.com", expirationDate: 1 }
  ], new URL("https://www-hj.douyin.com/aweme/v1/web/comment/list/"), 2000);
  assert.equal(header, "shared=yes; exact=yes");
});

test("HTTP 响应必须有成功状态和有效分页；空正文与错误正文不会出现在错误日志", () => {
  for (const body of ["", "credential=must-not-leak", JSON.stringify({ status_code: 1, status_msg: "must-not-leak" }),
    JSON.stringify({ status_code: 0, comments: [], cursor: 50, has_more: "0" })]) {
    assert.throws(() => parseHttpCommentPage(body, 1), error => error instanceof Error && !error.message.includes("must-not-leak"));
  }
  const end = parseHttpCommentPage(JSON.stringify({ status_code: 0, comments: null, cursor: 50, has_more: 0 }), 2);
  assert.equal(end.hasMore, false);
  assert.deepEqual(end.comments, []);
  const page = parseHttpCommentPage(JSON.stringify({ status_code: 0, cursor: 50, has_more: 1, total: 100,
    comments: [{ cid: "id", text: "图评", image_list: [{ url: "https://example.test/image" }], reply_comment_total: 2 }] }), 3);
  assert.equal(page.comments[0].id, "id");
  assert.equal(page.comments[0].images?.length, 1);
  assert.equal(page.apiMs, 3);
});
