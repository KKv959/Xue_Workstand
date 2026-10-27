import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { getGrossMarginMonitorAvatar } from "../src/lib/gross-margin-avatars";
import type { GrossMarginMonitorRecord } from "../src/lib/types";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b1sAAAAASUVORK5CYII=", "base64");
const record = (accountName: string) => ({ platform: "bilibili", accountName, videoKey: "BV1xx411c7mD", videoUrl: "https://www.bilibili.com/video/BV1xx411c7mD" }) as GrossMarginMonitorRecord;

async function isolated(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gross-margin-avatar-"));
  const previous = process.env.STYLE_LIBRARY_DIR;
  const previousFetch = globalThis.fetch;
  process.env.STYLE_LIBRARY_DIR = root;
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function metadata(face = "https://i0.hdslb.com/bfs/face/example.png") {
  return Response.json({ code: 0, data: { owner: { face } } });
}

test("头像按账号别名复用本地缓存，并合并并发请求，不修改监控记录", async t => {
  const root = await isolated(t);
  let calls = 0;
  globalThis.fetch = async input => {
    calls += 1;
    return String(input).includes("api.bilibili.com") ? metadata() : new Response(png);
  };
  const original = record("上官北丶");
  const snapshot = JSON.stringify(original);
  const results = await Promise.all([getGrossMarginMonitorAvatar(original), getGrossMarginMonitorAvatar(record("上官北"))]);
  assert.equal(calls, 2);
  assert.equal(results[0].contentType, "image/png");
  assert.deepEqual(results[0].bytes, png);
  assert.equal(JSON.stringify(original), snapshot);
  globalThis.fetch = async () => { throw new Error("不应再次联网"); };
  assert.deepEqual((await getGrossMarginMonitorAvatar(record("上官北"))).bytes, png);
  assert.equal((await fs.readdir(path.join(root, "gross-margin", "avatar-cache"))).length, 1);
});

test("头像拒绝非 B站图片地址、超限和无效图片，失败不写入缓存且可重试", async t => {
  const root = await isolated(t);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return metadata("https://localhost/private.png"); };
  await assert.rejects(getGrossMarginMonitorAvatar(record("非CDN")), /不受支持的头像地址/);
  assert.equal(calls, 1);
  globalThis.fetch = async input => String(input).includes("api.bilibili.com")
    ? metadata() : new Response("x", { headers: { "content-length": "2097153" } });
  await assert.rejects(getGrossMarginMonitorAvatar(record("大图片")), /超过 2MB/);
  globalThis.fetch = async input => String(input).includes("api.bilibili.com") ? metadata() : new Response("not an image");
  await assert.rejects(getGrossMarginMonitorAvatar(record("坏图片")), /图片内容无效/);
  await assert.rejects(fs.access(path.join(root, "gross-margin", "avatar-cache")));
  globalThis.fetch = async input => String(input).includes("api.bilibili.com") ? metadata() : new Response(png);
  assert.deepEqual((await getGrossMarginMonitorAvatar(record("坏图片"))).bytes, png);
});

test("取消、非 B站和伪造的视频源不会触发头像外部请求", async t => {
  await isolated(t);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return metadata(); };
  await assert.rejects(getGrossMarginMonitorAvatar({ ...record("抖音"), platform: "douyin" }), /不支持/);
  await assert.rejects(getGrossMarginMonitorAvatar({ ...record("伪造"), videoUrl: "https://evil.test/b23.tv/a" }), /有效的 B站视频链接/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getGrossMarginMonitorAvatar(record("取消"), controller.signal), /加载账号头像失败/);
  assert.equal(calls, 0);
});

test("多账号头像下载最多四个并发", async t => {
  await isolated(t);
  let active = 0;
  let max = 0;
  globalThis.fetch = async input => {
    active += 1;
    max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return String(input).includes("api.bilibili.com") ? metadata() : new Response(png);
  };
  await Promise.all(Array.from({ length: 9 }, (_, i) => getGrossMarginMonitorAvatar(record(`账号${i}`))));
  assert.equal(max, 4);
});
