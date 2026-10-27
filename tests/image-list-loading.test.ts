import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCachedImageRecords, getImageRecords, invalidateImageRecordsCache } from "../src/lib/client";
import { listImageRecords, saveImageRecord } from "../src/lib/storage/images";
import { storageFs } from "../src/lib/storage/fs";

test("生图列表复用缓存和并发请求，失效后旧请求不能覆盖新列表", async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  let finishOld: ((response: Response) => void) | undefined;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return new Promise<Response>((resolve) => { finishOld = resolve; });
    return Response.json({ records: [], total: 2 });
  };
  invalidateImageRecordsCache();
  try {
    const old = getImageRecords();
    assert.equal(getImageRecords(), old, "同时读取只发一次请求");
    invalidateImageRecordsCache();
    const current = await getImageRecords();
    finishOld!(Response.json({ records: [], total: 1 }));
    await old;
    assert.equal(getCachedImageRecords(), current, "失效前的请求不能恢复过期缓存");
    assert.equal((await getImageRecords()).total, 2);
    assert.equal(requests, 2, "再次进入复用缓存，不额外请求");
    invalidateImageRecordsCache();
    assert.equal(getCachedImageRecords(), null);
    await getImageRecords();
    assert.equal(requests, 3, "手动刷新或数据变更后重新读取");
  } finally {
    invalidateImageRecordsCache();
    globalThis.fetch = previousFetch;
  }
});

test("生图列表读取失败可见，后续可以重试", async () => {
  const previousFetch = globalThis.fetch;
  invalidateImageRecordsCache();
  try {
    globalThis.fetch = async () => Response.json({ error: "读取生图历史失败" }, { status: 500 });
    await assert.rejects(getImageRecords(), /读取生图历史失败/);
    assert.equal(getCachedImageRecords(), null);
    globalThis.fetch = async () => Response.json({ records: [], total: 0 });
    assert.equal((await getImageRecords()).total, 0);
  } finally {
    invalidateImageRecordsCache();
    globalThis.fetch = previousFetch;
  }
});

test("生图历史有界并行读取保持过滤、排序、分页和损坏文件报错", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-list-loading-"));
  const previousRoot = process.env.STYLE_LIBRARY_DIR;
  const previousRead = storageFs.readFile;
  process.env.STYLE_LIBRARY_DIR = root;
  let active = 0;
  let peak = 0;
  try {
    for (let index = 0; index < 14; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      await saveImageRecord({ schemaVersion: 1, id: `image-${index}`, canvasId: index < 12 ? "board-a" : "board-b", prompt: "测试图片", size: "1024x1024", quality: "auto", count: 1, referenceIds: [], model: "test-model", createdAt: timestamp, updatedAt: timestamp, images: [], ...(index === 11 ? { deletedAt: timestamp } : {}) });
    }
    storageFs.readFile = async (target, encoding) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await previousRead(target, encoding);
      } finally { active -= 1; }
    };
    const result = await listImageRecords(1, 2, "board-a");
    assert.equal(result.total, 11);
    assert.deepEqual(result.records.map((record) => record.id), ["image-9", "image-8"]);
    assert.ok(peak > 1 && peak <= 6, "并行读取有上限，不串行等待全部历史");
    assert.equal("prompt" in result.records[0], false);
    assert.equal("images" in result.records[0], false);
    storageFs.readFile = previousRead;
    await writeFile(path.join(root, "images", "records", "image-0.json"), "broken-json");
    await assert.rejects(listImageRecords(), /JSON 文件损坏/);
  } finally {
    storageFs.readFile = previousRead;
    if (previousRoot === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
