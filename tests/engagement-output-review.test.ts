import assert from "node:assert/strict";
import test from "node:test";
import { parseGeneratedCommentReview } from "../src/lib/engagement";

test("新评论质检完整覆盖候选并按编号恢复，记录语义重复拒绝理由", () => {
  const result = parseGeneratedCommentReview(JSON.stringify({ decisions: [
    { id: 1, keep: false, reason: "与上一条重复询问上线年份" }, { id: 0, keep: true }
  ] }), 2);
  assert.equal(result.reviewedCount, 2);
  assert.equal(result.rejectedCount, 1);
  assert.deepEqual(result.decisions.map((row) => row.id), [0, 1]);
});

test("新评论质检漏评、重复编号、越界、无拒绝理由和错误结果均显式失败", () => {
  for (const decisions of [
    [], [{ id: 0, keep: true }], [{ id: 0, keep: true }, { id: 0, keep: true }],
    [{ id: 0, keep: true }, { id: 2, keep: true }],
    [{ id: 0, keep: true }, { id: 1, keep: false }],
    [{ id: 0, keep: true }, { id: 1, keep: false, reason: "  " }],
    [{ id: 0, keep: "true" }, { id: 1, keep: true }], [null, null]
  ]) assert.throws(() => parseGeneratedCommentReview(JSON.stringify({ decisions }), 2), /质检/);
  assert.throws(() => parseGeneratedCommentReview("模型异常", 2), /质检/);
});

test("精简质检编号仍必须完整覆盖，保留和拒绝不能重复或漏项", () => {
  const result = parseGeneratedCommentReview('{"keep":[2,0],"reject":[{"id":1,"reason":"重复观点"}]}', 3);
  assert.deepEqual(result.decisions.map((row) => row.keep), [true, false, true]);
  for (const value of [{ keep: [0], reject: [] }, { keep: [0, 0], reject: [] },
    { keep: [0], reject: [{ id: 0, reason: "重复" }] }, { keep: [0, 2], reject: [] },
    { keep: [0], reject: [{ id: 1 }] }]) {
    assert.throws(() => parseGeneratedCommentReview(JSON.stringify(value), 2), /质检/);
  }
});
