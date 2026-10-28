import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLibraryBootstrap } from "../src/lib/library-bootstrap";
import { saveTranscript, saveVideos, upsertAccount } from "../src/lib/storage";
import type { Video } from "../src/lib/types";

test("首屏遵守深链和筛选，只返回当前原稿摘要，读取失败保留列表并显式报错", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "library-bootstrap-"));
  const previous = process.env.STYLE_LIBRARY_DIR;
  process.env.STYLE_LIBRARY_DIR = root;
  try {
    const account = await upsertAccount({ platform: "douyin", uid: "bootstrap", name: "测试账号" });
    const videos: Video[] = [1, 2].map(i => ({ id: `v${i}`, platform: "douyin", accountId: account.id, title: `标题${i}`, url: `https://example.com/${i}`,
      stats: { views: 100, likes: i, comments: 0, favorites: 0, shares: 0 }, hotScore: i, relativeViewRate: 1, transcriptStatus: "pending", updatedAt: new Date().toISOString() }));
    await saveVideos(account, videos);
    for (const video of videos) await saveTranscript({ platform: "douyin", accountId: account.id, videoId: video.id, text: video.id.repeat(1000), source: "manual" });
    const first = await getLibraryBootstrap(new URLSearchParams({ account: account.id, video: "v1" }));
    assert.equal(first.account?.id, account.id);
    assert.equal(first.transcript?.videoId, "v1");
    assert.equal(first.transcript?.preview.length, 481);
    assert.ok(!JSON.stringify(first).includes("v1".repeat(1000)));
    const filtered = await getLibraryBootstrap(new URLSearchParams({ video: "v1", vq: "标题2" }));
    assert.equal(filtered.transcript?.videoId, "v2");
    const sorted = await getLibraryBootstrap(new URLSearchParams({ sort: "title", dir: "asc" }));
    assert.equal(sorted.transcript?.videoId, "v1");
    assert.equal((await getLibraryBootstrap(new URLSearchParams({ q: "无此账号" }))).account, null);
    assert.equal((await getLibraryBootstrap(new URLSearchParams({ vq: "无此视频" }))).transcript, null);
    await rm(path.join(root, "douyin", account.slug, "transcripts", "v1.txt"));
    const missing = await getLibraryBootstrap(new URLSearchParams({ video: "v1" }));
    assert.equal(missing.account?.videos.length, 2);
    assert.ok(missing.transcript?.error);
  } finally {
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR; else process.env.STYLE_LIBRARY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
