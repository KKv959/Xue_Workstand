import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cachedWriterResearch, WRITER_RESEARCH_CACHE_TTL_MS } from "../src/lib/storage/writer-research";

test("写作检索缓存：并发合并、持久化、到期刷新、失败与取消隔离", async () => {
  const previous = process.env.STYLE_LIBRARY_DIR;
  const root = await mkdtemp(path.join(tmpdir(), "writer-cache-"));
  process.env.STYLE_LIBRARY_DIR = root;
  let time = Date.now();
  let calls = 0;
  const messages: string[] = [];
  const options = { now: () => time, onProgress: (message: string) => messages.push(message) };
  const fetcher = async () => ({ content: `资料${++calls}`, cacheable: true });
  try {
    assert.deepEqual(await Promise.all([
      cachedWriterResearch("same", fetcher, options), cachedWriterResearch("same", fetcher, options)
    ]), ["资料1", "资料1"]);
    assert.equal(calls, 1);
    assert.ok(messages.some(message => message.includes("已复用")));
    const directory = path.join(root, ".cache", "writer-research");
    const target = path.join(directory, (await readdir(directory))[0]);
    const persisted = JSON.parse(await readFile(target, "utf8"));
    assert.equal(persisted.schemaVersion, 1);
    // 直接改变磁盘记录，确保后续复用来自持久化文件。
    await writeFile(target, JSON.stringify({ ...persisted, content: "磁盘资料" }));
    assert.equal(await cachedWriterResearch("same", fetcher, options), "磁盘资料");
    time += WRITER_RESEARCH_CACHE_TTL_MS;
    assert.equal(await cachedWriterResearch("same", fetcher, options), "资料2");
    await cachedWriterResearch("changed-input-or-config", fetcher, options);
    assert.equal(calls, 3);
    const failure = async () => ({ content: "检索暂不可用", cacheable: false });
    await cachedWriterResearch("failure", failure, options);
    assert.equal(await cachedWriterResearch("failure", fetcher, options), "资料4");
    await assert.rejects(cachedWriterResearch("error", async () => { throw new Error("网络失败"); }, options), /网络失败/);
    assert.equal(await cachedWriterResearch("error", fetcher, options), "资料5");

    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const active = cachedWriterResearch("waiting", async () => { started(); await held; return fetcher(); }, options);
    await ready;
    const controller = new AbortController();
    const waiting = cachedWriterResearch("waiting", fetcher, { ...options, signal: controller.signal });
    controller.abort(new Error("用户取消"));
    await assert.rejects(waiting, /用户取消/);
    release();
    assert.equal(await active, "资料6", "取消等待者不会中断正在执行的检索");
    assert.equal(await cachedWriterResearch("waiting", fetcher, options), "资料6");
    const cancelled = new AbortController();
    await assert.rejects(cachedWriterResearch("cancel-active", async () => {
      cancelled.abort(new Error("主动取消")); return { content: "不应保存", cacheable: true };
    }, { ...options, signal: cancelled.signal }), /主动取消/);
    assert.equal(await cachedWriterResearch("cancel-active", fetcher, options), "资料7");

    time += WRITER_RESEARCH_CACHE_TTL_MS;
    await assert.rejects(cachedWriterResearch("same", async () => { throw new Error("过期后请求失败"); }, options), /过期后请求失败/);
    assert.equal(JSON.parse(await readFile(target, "utf8")).content, "资料2", "失败不覆盖旧缓存，也不悄悄返回过期结果");
    await writeFile(target, '{"schemaVersion":99}');
    await assert.rejects(cachedWriterResearch("same", fetcher, options), /缓存损坏/);
    assert.equal(await readFile(target, "utf8"), '{"schemaVersion":99}');
  } finally {
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR; else process.env.STYLE_LIBRARY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
