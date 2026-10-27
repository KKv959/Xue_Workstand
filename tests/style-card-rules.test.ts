import assert from "node:assert/strict";
import test from "node:test";
import { validateStyleCardCitations } from "../src/lib/writer-context";

const evidence = [{ sourceId: "a", quote: "先把事情讲清楚，再顺势说自己的看法。" }];
test("蒸馏卡无需编号、固定章节或引用，也兼容旧卡", () => {
  validateStyleCardCitations("# 讲述特点\n评价融入叙述，先给读者理解事情的线索。", evidence);
  validateStyleCardCitations("自然讲述，按内容安排节奏。");
  validateStyleCardCitations(`### S01｜讲述\n[[a]]「${evidence[0].quote}」`, evidence);
});
test("可选引用仍核验来源和连续原句", () => {
  validateStyleCardCitations("说明：[[a]]「先把事情讲清楚」", evidence);
  assert.throws(() => validateStyleCardCitations("[[b]]「先把事情讲清楚」", evidence), /引用/);
  assert.throws(() => validateStyleCardCitations("[[a]]「先说自己的看法」", evidence), /引用/);
  assert.throws(() => validateStyleCardCitations("[[a]]「先把事情讲清楚」"), /引用/);
  assert.throws(() => validateStyleCardCitations("[[a]]「先把事情讲清楚", evidence), /引用/);
});
test("空结果仍失败，避免覆盖可用风格卡", () => {
  assert.throws(() => validateStyleCardCitations("  ", evidence), /内容为空/);
});
