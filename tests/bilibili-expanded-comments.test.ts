import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBilibiliExpandedComments, parseBilibiliCommentPage, signBilibiliCommentUrl } from "../src/lib/opencli-bilibili-comments";

test("扩展 B站评论页只在首批读置顶，允许正常结束的空评论区", () => {
  const pinned = { rpid_str: "1", content: { message: "置顶评论" } };
  const reply = { rpid_str: "2", content: { message: "普通评论" } };
  const payload = { code: 0, data: { cursor: { next: 1, is_end: false }, top_replies: [pinned], replies: [reply] } };
  assert.deepEqual(parseBilibiliCommentPage(payload, true).rows, [pinned, reply]);
  assert.deepEqual(parseBilibiliCommentPage(payload, false).rows, [reply]);
  assert.deepEqual(parseBilibiliCommentPage({ code: 0, data: { cursor: { is_end: true }, replies: null } }, false), { rows: [], next: 0, end: true });
  assert.deepEqual(parseBilibiliCommentPage({ code: 0, data: { cursor: { is_end: true }, replies: [], top: { upper: null } } }, true), { rows: [], next: 0, end: true });
  assert.match(signBilibiliCommentUrl("123", "a".repeat(32), "b".repeat(32), 0), /mode=3/);
});

test("B站采集拒绝访问限制、错误结构与无效游标，不伪造成功", () => {
  for (const code of [-101, -352, 403, 412, 429]) {
    assert.throws(() => parseBilibiliCommentPage({ code }, true), new RegExp(String(code)));
  }
  for (const next of [undefined, -1, 0.5, "1"]) {
    assert.throws(() => parseBilibiliCommentPage({ code: 0, data: { cursor: { next, is_end: false }, replies: [] } }, true), /分页/);
  }
  assert.throws(() => parseBilibiliCommentPage("登录页面", true), /字段异常/);
  assert.throws(() => parseBilibiliCommentPage({ code: 0, data: { cursor: { next: 1, is_end: false }, replies: [] } }, false), /空页但仍有后续/);
  assert.throws(() => signBilibiliCommentUrl("bad-id", "a".repeat(32), "b".repeat(32), 0), /签名参数/);
});

test("评论分页不打开视频页：标签页不在 B站时只打开首页一次，之后按 500ms 节奏逐页读取", async () => {
  const env = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "bili-session-"));
  for (const key of Object.keys(process.env)) if (/^OPENCLI_/.test(key)) delete process.env[key];
  Object.assign(process.env, { OPENCLI_NODE_BIN: process.execPath, OPENCLI_SCRIPT: path.resolve("tests/fixtures/bilibili-session-cli.mjs"),
    OPENCLI_BROWSER_SESSION: "bili-session-fixture", BILI_SESSION_STATE: path.join(root, "opened.json") });
  try {
    const traces: Array<{ pages: unknown[]; stopReason: string }> = [];
    const started = Date.now();
    const first = await getBilibiliExpandedComments("BV1xx411c7mD", 200, undefined, (trace) => traces.push(trace));
    assert.ok(Date.now() - started >= 480, "两页之间保留 500ms 间隔");
    const second = await getBilibiliExpandedComments("BV1yy411c7mD", 200, undefined, (trace) => traces.push(trace));
    assert.equal(first.length, 60);
    assert.equal(second.length, 60);
    assert.deepEqual(traces.map((trace) => [trace.pages.length, trace.stopReason]), [[2, "exhausted"], [2, "exhausted"]]);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "opened.json"), "utf8")), ["https://www.bilibili.com"], "只为建立会话打开首页一次，不打开任何视频页");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
