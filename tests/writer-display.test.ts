import assert from "node:assert/strict";
import test from "node:test";
import { formatLongDraftForDisplay, LONG_DRAFT_DISPLAY_THRESHOLD } from "../src/lib/writer-display";

test("800 字以内的文案保持原样", () => {
  const content = "第一句。\n\n第二句。";
  assert.ok(content.replace(/\s/g, "").length <= LONG_DRAFT_DISPLAY_THRESHOLD);
  assert.equal(formatLongDraftForDisplay(content), content);
});

test("长文案合并逐句换行，并按自然句群分段", () => {
  const content = Array.from({ length: 80 }, (_, index) => `这是第${index + 1}句用于测试长文案排版的内容。`).join("\n\n");
  const formatted = formatLongDraftForDisplay(content);

  assert.ok(content.replace(/\s/g, "").length > LONG_DRAFT_DISPLAY_THRESHOLD);
  assert.ok(formatted.length < content.length);
  assert.ok((formatted.match(/\n\n/g) || []).length < 20);
  assert.ok(formatted.includes("。\n\n"));
  assert.equal(formatted.replace(/\s/g, "").length, content.replace(/\s/g, "").length);
});

test("长文案保留标题、列表等结构行", () => {
  const body = Array.from({ length: 60 }, (_, index) => `正文第${index + 1}句，保持信息顺序和原意。`).join("\n\n");
  const content = `# 这是标题\n\n${body}\n\n- 这是重点列表\n\n${body}`;
  const formatted = formatLongDraftForDisplay(content);

  assert.match(formatted, /^# 这是标题\n\n/);
  assert.match(formatted, /\n\n- 这是重点列表\n\n/);
  assert.equal(formatted.replace(/\s/g, "").length, content.replace(/\s/g, "").length);
});
