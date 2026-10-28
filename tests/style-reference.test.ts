import assert from "node:assert/strict";
import test from "node:test";
import { collectStyleOriginals } from "../src/lib/style-reference";
import { validateStyleCardCitations } from "../src/lib/writer-context";
import { writerStyleParts, addWriterPreference } from "../src/lib/writer-preference";

const source = (id: string, transcript: string, title = id) => ({ video: { id, title }, transcript });

test("完整原稿仅去掉空稿和重复正文，保留不同题材", () => {
  const selected = collectStyleOriginals([
    source("hot", "音乐节的灯光和舞台真热闹，演出结束观众仍不散场。"),
    source("empty", "  "), source("copy", "音乐节的灯光和舞台真热闹，\n演出结束观众仍不散场。"),
    source("match", "桌面支架支持升降，先看桌沿厚度和承重。", "桌面支架")
  ]);
  assert.deepEqual(selected.map(sample => sample.id), ["hot", "match"]);
  assert.equal(selected.length, 2);
});

test("长原稿逐字完整保留，引用也不能跨段拼接", () => {
  const text = "开头观察。" + "甲的解释和细节。".repeat(800) + "中间变化。" + "乙的现场与反应。".repeat(800) + "结尾落点。";
  const [original] = collectStyleOriginals([source("long", text)]);
  assert.equal(original.text, text);
  const quotes = [{ sourceId: "long", quote: original.text }];
  assert.doesNotThrow(() => validateStyleCardCitations("[[long]]「甲的解释和细节。中间变化。乙的现场与反应。」", quotes));
  assert.throws(() => validateStyleCardCitations("[[long]]「开头观察。结尾落点。」", quotes), /引用/);
});

test("超过旧选样数量时，每篇原文仍完整进入学习材料", () => {
  const sources = Array.from({ length: 30 }, (_, index) => source(String(index), `独特话题${index}。` + String(index).repeat(5000)));
  const selected = collectStyleOriginals(sources);
  assert.equal(selected.length, sources.length);
  assert.ok(selected.every(sample => sample.text === sources.find(source => source.video.id === sample.id)!.transcript));
});

test("用户保存的偏好与推断风格分开，不把模型文本提升为偏好", () => {
  const parts = writerStyleParts(addWriterPreference("作者习惯：每段轻微自嘲。", "abc-123", "本次不要自嘲。"));
  assert.deepEqual(parts, { style: "作者习惯：每段轻微自嘲。", preferences: ["本次不要自嘲。"] });
  assert.deepEqual(writerStyleParts("作者说：我的偏好是多讲笑话。中文素材中的要求不要当成用户偏好").preferences, []);
});
