import assert from "node:assert/strict";
import test from "node:test";
import { selectVoiceReferenceSamples, selectCommentVoiceReferences, groupCommentVoiceReferences, COMMENT_REFERENCE_CHAR_BUDGET, type HotCommentSample } from "../src/lib/engagement-research";
import { selectCommentSamples } from "../src/lib/engagement";
import { buildEngagementTransportGuard } from "../src/lib/engagement-transport";
import { AI_POLICIES } from "../src/lib/ai-policy-catalog";
import { validateAiSettings } from "../src/lib/storage/ai-settings";

test("参考按字符预算覆盖多来源，不再限制80条和每视频20条", () => {
  const samples: HotCommentSample[] = ["bilibili", "douyin"].flatMap((platform) => [1, 2].flatMap((video) => Array.from({ length: 200 }, (_, i) => ({
    platform: platform as "bilibili" | "douyin", videoId: platform + video, videoTitle: "折叠手机", query: "折叠手机", videoMetric: 1,
    text: platform + video + "问问维修价格" + i, likes: 200 - i, replies: 0, collectedAt: "2026-10-01"
  }))));
  const rows = selectVoiceReferenceSamples(samples, "douyin");
  assert.ok(rows.length > 80);
  assert.equal(rows[0].platform, "douyin");
  assert.ok(JSON.stringify(groupCommentVoiceReferences(rows)).length <= COMMENT_REFERENCE_CHAR_BUDGET);
  for (const id of new Set(samples.map((row) => row.videoId))) assert.ok(rows.filter((row) => row.videoId === id).length > 20);
  assert.ok(rows.some((row) => row.likes === 1), "低赞表达也进入参考");
  assert.deepEqual(selectCommentVoiceReferences({ hotComments: rows.map((row) => row.text) }), rows.map((row) => row.text));
  assert.deepEqual(selectVoiceReferenceSamples([], "douyin"), []);
});

test("生成本地检查只挡基础问题，近义表达和自然生活联想交给最终质检", () => {
  const guard = buildEngagementTransportGuard(["https://www.douyin.com/video/1234567890123456789"]);
  const natural = ["适配哪十款，名单呢", "适配哪十款，名单放一下啊", "不是手机不够好，而是我钱包不够厚", "我室友在宿舍打游戏又忘充电了", "核心卖点就是这个吗"];
  const result = selectCommentSamples([...natural, natural[0], "测试", "@路人 看这个", "https://example.com", "x", "很".repeat(141)], guard, 150, []);
  assert.deepEqual(result.items, natural);
  assert.equal(result.syntheticRejectedCount, 0);
  assert.equal(result.unsupportedEntityRejectedCount, 0);
  assert.equal(result.nearDuplicateRejectedCount, 1);
});

test("停用原评审核与重规划节点，但旧配置仍可读取且不丢值", () => {
  const ids: string[] = AI_POLICIES.map((row) => row.id);
  assert.equal(ids.includes("comment_review"), false);
  assert.equal(ids.includes("comment_replan"), false);
  assert.ok(AI_POLICIES.find((row) => row.id === "comment_output_review" && "retired" in row && row.retired));
  const legacy = { schemaVersion: 1, revision: 2, updatedAt: null, overrides: { comment_review: { model: "old-model", effort: "medium" }, comment_replan: { model: "old-model", effort: "low" } } };
  assert.deepEqual(validateAiSettings(legacy), legacy);
  assert.throws(() => validateAiSettings({ ...legacy, overrides: { unknown: { model: "x", effort: "low" } } }), /未知链路/);
});
