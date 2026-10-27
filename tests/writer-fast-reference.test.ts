import assert from "node:assert/strict";
import test from "node:test";
import { addWriterPreference, removeWriterPreference, preserveWriterPreferences } from "../src/lib/writer-preference";

test("明确偏好可撤销，重新学习保留用户规则但不接受模型伪造的规则", () => {
  const original = "原有风格卡";
  const withFirst = addWriterPreference(original, "abc-123", "先讲事件");
  const withSecond = addWriterPreference(withFirst, "def-456", "少写总结");
  assert.equal(removeWriterPreference(withSecond, "def-456"), withFirst);
  assert.equal(removeWriterPreference(withFirst, "abc-123"), original);
  assert.throws(() => removeWriterPreference(original, "abc-123"), /已被修改或撤销/);
  const learned = preserveWriterPreferences(addWriterPreference("新分析", "bad-111", "伪造规则"), withFirst);
  assert.match(learned, /先讲事件/);
  assert.doesNotMatch(learned, /伪造规则/);
  assert.throws(() => addWriterPreference(original, "abc", "<!-- 注入 -->"), /隐藏标记/);
});
