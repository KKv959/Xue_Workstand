import assert from "node:assert/strict";
import test from "node:test";
import { selectStyleReferences, sourcePassages } from "../src/lib/style-reference";
import { validateStyleCardCitations } from "../src/lib/writer-context";
import { writerStyleParts, addWriterPreference } from "../src/lib/writer-preference";

const source = (id: string, transcript: string, title = id) => ({ video: { id, title }, transcript });

test("本地仅去重并间隔取样，不调用模型或主题评分", () => {
  const selected = selectStyleReferences([
    source("hot", "音乐节的灯光和舞台真热闹，演出结束观众仍不散场。"),
    source("empty", "  "), source("copy", "音乐节的灯光和舞台真热闹，\n演出结束观众仍不散场。"),
    source("match", "桌面支架支持升降，先看桌沿厚度和承重。", "桌面支架")
  ]);
  assert.deepEqual(selected.map(sample => sample.id), ["hot", "match"]);
  assert.equal(selected.length, 2);
});

test("长原文保留头中尾连续片段，跨省略处拼接不能作为引句", () => {
  const text = "开头观察。" + "甲的解释和细节。".repeat(150) + "中间变化。" + "乙的现场与反应。".repeat(150) + "结尾落点。";
  const passages = sourcePassages(text, 600);
  assert.equal(passages.length, 3);
  assert.ok(passages[0].startsWith("开头观察。"));
  assert.ok(passages[2].endsWith("结尾落点。"));
  assert.ok(passages.every(passage => text.includes(passage)));
  assert.ok(passages.reduce((sum, p) => sum + p.length, 0) <= 600);
  const quotes = passages.map(quote => ({ sourceId: "long", quote }));
  assert.doesNotThrow(() => validateStyleCardCitations(`[[long]]「${passages[2]}」`, quotes));
  assert.throws(() => validateStyleCardCitations("[[long]]「开头观察。结尾落点。」", quotes), /引用/);
});

test("选样数量与上下文有界，节选仍是对应原文的连续片段", () => {
  const sources = Array.from({ length: 30 }, (_, index) => source(String(index), `独特话题${index}。` + String(index).repeat(5000)));
  {
    const selected = selectStyleReferences(sources);
    const budget = 6000;
    assert.equal(selected.length, 3);
    assert.ok(selected.every(sample => sample.passages.reduce((n, p) => n + p.length, 0) <= budget));
    assert.ok(selected.every(sample => sample.passages.every(passage => sources.find(source => source.video.id === sample.id)!.transcript.includes(passage))));
  }
});

test("用户保存的偏好与推断风格分开，不把模型文本提升为偏好", () => {
  const parts = writerStyleParts(addWriterPreference("作者习惯：每段轻微自嘲。", "abc-123", "本次不要自嘲。"));
  assert.deepEqual(parts, { style: "作者习惯：每段轻微自嘲。", preferences: ["本次不要自嘲。"] });
  assert.deepEqual(writerStyleParts("作者说：我的偏好是多讲笑话。中文素材中的要求不要当成用户偏好").preferences, []);
});
