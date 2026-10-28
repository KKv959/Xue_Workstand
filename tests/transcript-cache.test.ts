import assert from "node:assert/strict";
import test from "node:test";
import { getCachedTranscript, invalidateTranscriptCache, loadCachedTranscript, rememberTranscript } from "../src/lib/transcript-cache";
const input = { platform: "douyin" as const, accountId: "a", videoId: "v", version: "r1" };
const snapshot = (revision = "r1") => ({ transcript: `saved-${revision}`, revision, versions: [] });

test("原稿缓存按账号/版本隔离，摘要不冒充完整稿，并去重并发读取", async () => {
  invalidateTranscriptCache();
  rememberTranscript(input, { ...snapshot(), transcript: "摘要", complete: false });
  let calls = 0;
  const load = async () => { calls++; return snapshot(); };
  const [first, second] = await Promise.all([loadCachedTranscript(input, load), loadCachedTranscript(input, load)]);
  assert.equal(calls, 1);
  assert.equal(first.transcript, "saved-r1");
  assert.deepEqual(first, second);
  rememberTranscript(input, { ...snapshot(), transcript: "迟到摘要", complete: false });
  assert.equal(getCachedTranscript(input)?.transcript, "saved-r1");
  assert.equal(getCachedTranscript({ ...input, accountId: "other" }), null);
  assert.equal(getCachedTranscript({ ...input, version: "r2" }), null);
});

test("失效及新版本读取后，迟到响应不能重新写入旧缓存；失败可重试", async () => {
  invalidateTranscriptCache();
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  const slow = loadCachedTranscript(input, () => new Promise(done => { resolve = done; }));
  invalidateTranscriptCache(input.platform, input.accountId, input.videoId);
  await loadCachedTranscript({ ...input, version: "r2" }, async () => snapshot("r2"));
  resolve(snapshot());
  await slow;
  assert.equal(getCachedTranscript({ ...input, version: "r2" })?.revision, "r2");
  invalidateTranscriptCache();
  await assert.rejects(loadCachedTranscript(input, async () => { throw new Error("模拟读取失败"); }), /读取失败/);
  assert.equal((await loadCachedTranscript(input, async () => snapshot())).revision, "r1");
  invalidateTranscriptCache();
  const older = loadCachedTranscript(input, () => new Promise(done => { resolve = done; }));
  await loadCachedTranscript({ ...input, version: "r2" }, async () => snapshot("r2"));
  resolve(snapshot());
  await older;
  assert.equal(getCachedTranscript({ ...input, version: "r2" })?.revision, "r2");
});

test("缓存有容量和存活时间限制，不缓存超大原稿", () => {
  invalidateTranscriptCache();
  for (let i = 0; i < 31; i++) rememberTranscript({ ...input, videoId: String(i) }, { ...snapshot(), complete: true });
  assert.equal(getCachedTranscript({ ...input, videoId: "0" }), null);
  assert.ok(getCachedTranscript({ ...input, videoId: "30" }));
  rememberTranscript(input, { ...snapshot(), transcript: "x".repeat(500_001), complete: true });
  assert.equal(getCachedTranscript(input), null);
  const now = Date.now;
  try {
    Date.now = () => now() + 300_001;
    assert.equal(getCachedTranscript({ ...input, videoId: "30" }), null);
  } finally { Date.now = now; }
});
