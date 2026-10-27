import assert from "node:assert/strict";
import test from "node:test";
import { appendWriterSourceFiles } from "../src/lib/source-file-import";
import { splitWriterSourceItems } from "../src/app/writer/_lib/source-items";

test("mixed input preserves exact ranges and independently removes duplicate file names", () => {
  const source = appendWriterSourceFiles("原文\n保留换行", ["第一份", "第二份"].map((text) => ({ name: "相同.txt", text, mimeType: "text/plain", originalCharacters: text.length, truncated: false }))) + "\n\nhttps://example.com/doc";
  const items = splitWriterSourceItems(source);
  assert.deepEqual(items.map((item) => item.kind), ["text", "file", "file", "link"]);
  for (const item of items) assert.equal(source.slice(item.start, item.end), item.raw);
  const removed = source.slice(0, items[1].start) + source.slice(items[1].end);
  assert.equal(splitWriterSourceItems(removed).filter((item) => item.kind === "file")[0].content, "第二份");
  assert.ok(removed.startsWith("原文\n保留换行"));
  assert.ok(removed.endsWith("https://example.com/doc"));
});

test("malformed and nested markers stay intact as text", () => {
  for (const source of ["===== 本地文件：broken.txt =====\n未结束", "===== 本地文件：a =====\n===== 本地文件：b =====\n内容\n===== 文件结束 ====="]) {
    assert.deepEqual(splitWriterSourceItems(source).map((item) => [item.kind, item.raw]), [["text", source]]);
  }
});

test("CRLF and truncation markers retain the original text", () => {
  const source = "===== 本地文件：a.txt（已截取前 40000 字） =====\r\n正文\r\n===== 文件结束 =====\r\n";
  const [item] = splitWriterSourceItems(source);
  assert.equal(item.content, "正文");
  assert.equal(item.truncated, true);
  assert.equal(source.slice(item.start, item.end), item.raw);
});

test("standalone links are separate assets without splitting prose paragraphs", () => {
  const source = "第一段\n\n第二段\nhttps://example.com/a\nhttps://example.com/b\n结尾";
  const items = splitWriterSourceItems(source);
  assert.deepEqual(items.map((item) => item.kind), ["text", "link", "link", "text"]);
  assert.equal(items[0].content, "第一段\n\n第二段");
  const removed = source.slice(0, items[1].start) + source.slice(items[1].end);
  assert.ok(removed.includes("https://example.com/b"));
  assert.ok(removed.startsWith("第一段\n\n第二段"));
});
