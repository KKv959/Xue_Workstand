import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { selectEligibleCommentSources, sourceCommentCount } from "../src/lib/engagement-source-selection";
import { getDouyinRelatedTopicComments } from "../src/lib/opencli";
import { getBilibiliRelatedTopicComments } from "../src/lib/opencli-bilibili";

test("来源门槛拒绝20及以下和未知，21、224、266条入选", async () => {
  const fetched: string[] = [];
  const result = await selectEligibleCommentSources([
    { id: "low", commentCount: 19 }, { id: "boundary", commentCount: 20 }, { id: "missing" }, { id: "valid" },
    { id: "middle", commentCount: 224 }, { id: "higher", commentCount: 266 }, { id: "unused" }
  ], 3, async (video) => { fetched.push(video.id); return video.id === "valid" ? 21 : undefined; });
  assert.deepEqual(result.videos, [{ id: "valid", commentCount: 21 }, { id: "middle", commentCount: 224 }, { id: "higher", commentCount: 266 }]);
  assert.deepEqual(fetched, ["missing", "valid"]);
  assert.match(result.errors.join("；"), /19.*超过 20.*评论总数 20.*无法确认评论总数/);
  for (const value of [undefined, null, "", "很多", NaN, -1, 299.9, [], true]) assert.equal(sourceCommentCount(value), undefined);
  assert.equal(sourceCommentCount("300"), 300);
});

test("计数核验取消和访问限制不会放行未知来源", async () => {
  const controller = new AbortController();
  await assert.rejects(selectEligibleCommentSources([{ id: "a" }], 1, async () => {
    controller.abort(new Error("用户取消")); return 300;
  }, controller.signal), /用户取消/);
  let calls = 0;
  const result = await selectEligibleCommentSources([{ id: "a" }, { id: "b" }], 2, async () => {
    calls++; throw new Error("HTTP 403，请检查登录");
  });
  assert.equal(calls, 1); assert.equal(result.videos.length, 0);
  assert.match(result.errors[0], /核验失败.*403/);
});

test("批量核验按排名分块，凑够来源即停；单条失败跳过，风控中止", async () => {
  const chunks: string[][] = [];
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const counts: Record<string, number | Error> = { a: 19, b: new Error("超时"), c: 300, d: 201, e: 400, f: 500, g: 600 };
  const result = await selectEligibleCommentSources(ids.map((id) => ({ id })), 2, {
    batchSize: 3,
    async resolveMany(videos) { chunks.push(videos.map((video) => video.id)); return new Map(videos.map((video) => [video.id, counts[video.id]])); }
  });
  assert.deepEqual(chunks, [["a", "b", "c"], ["d", "e", "f"]], "第二块凑够后不再核验第三块");
  assert.deepEqual(result.videos.map((video) => video.id), ["c", "d"]);
  assert.match(result.errors.join("；"), /a：评论总数 19 条.*b：评论总数核验失败，已跳过：超时/);

  const known = await selectEligibleCommentSources([{ id: "x", commentCount: 300 }, { id: "y" }], 2, {
    batchSize: 4, resolveMany: async (videos) => { assert.deepEqual(videos.map((video) => video.id), ["y"], "已有评论数不重复核验"); return new Map([["y", 250]]); }
  });
  assert.deepEqual(known.videos.map((video) => video.commentCount), [300, 250]);

  let batchCalls = 0;
  const blocked = await selectEligibleCommentSources(ids.map((id) => ({ id })), 3, {
    batchSize: 2, resolveMany: async () => { batchCalls++; throw new Error("B站评论接口 HTTP 412，请检查登录或访问限制"); }
  });
  assert.equal(batchCalls, 1);
  assert.equal(blocked.videos.length, 0);
  assert.equal(blocked.errors.length, 1, "风控后不再记录或核验后续候选");

  const controller = new AbortController();
  await assert.rejects(selectEligibleCommentSources([{ id: "a" }], 1, {
    batchSize: 2, resolveMany: async () => { controller.abort(new Error("用户取消")); return new Map([["a", 300]]); }
  }, controller.signal), /用户取消/);
});

test("双平台真实适配链路先核验详情，20条来源跳过、21条来源进入评论分页", async () => {
  const env = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^OPENCLI_/.test(key)) delete process.env[key];
  Object.assign(process.env, { OPENCLI_NODE_BIN: process.execPath,
    OPENCLI_SCRIPT: path.resolve("tests/fixtures/engagement-c-cli.mjs"),
    OPENCLI_BROWSER_SESSION: "source-minimum-fixture", COMMENT_TEST_CORPUS: "threshold" });
  try {
    const douyin = await getDouyinRelatedTopicComments("手机", { videoLimit: 2, commentLimit: 200 });
    const bili = await getBilibiliRelatedTopicComments("手机", { videoLimit: 2, commentLimit: 200, replyLimit: 0 });
    assert.deepEqual(douyin.videos.map((v) => [v.id, v.commentCount]), [["2222222222222222222", 21]]);
    assert.equal(bili.videos[0].views, 999);
    assert.deepEqual(bili.videos.map((v) => [v.id, v.commentCount]), [["BV2xx411c7mD", 21]]);
    for (const result of [douyin, bili]) {
      assert.equal(result.comments.length, 200);
      assert.equal(result.collectionAttempts?.length, 1, "低评论和未知来源不得发起评论分页");
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
