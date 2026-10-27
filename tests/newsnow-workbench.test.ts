import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { isNewsNowWorkbenchMessage, moveNewsNowCard, readNewsNowLayout, refreshNewsNowSources } from "../src/lib/newsnow-workbench-state";

test("卡片偏好保留顺序和隐藏状态，并兼容来源增删", () => {
  assert.deepEqual(readNewsNowLayout(null, ["a", "b"]), { schemaVersion: 1, order: ["a", "b"], hidden: [] });
  assert.deepEqual(readNewsNowLayout(JSON.stringify({ schemaVersion: 1, order: ["b", "old", "b"], hidden: ["old", "b", "b"] }), ["a", "b", "new"]), { schemaVersion: 1, order: ["b", "a", "new"], hidden: ["b"] });
  assert.throws(() => readNewsNowLayout("{", ["a"]));
  assert.throws(() => readNewsNowLayout('{"schemaVersion":2,"order":[],"hidden":[]}', ["a"]), /不兼容/);
  assert.deepEqual(moveNewsNowCard(["a", "b", "c"], "a", "c"), ["b", "c", "a"]);
  assert.deepEqual(moveNewsNowCard(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
});

test("刷新调度覆盖所有来源，限制并发并继续处理部分失败", async () => {
  const sources = Array.from({ length: 30 }, (_, index) => `source-${index}`);
  const called: string[] = [], completed: string[] = [], failures: string[] = [];
  let active = 0, maximum = 0;
  await refreshNewsNowSources(sources, async id => {
    called.push(id); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (id === "source-2") throw new Error("来源不可用");
  }, new AbortController().signal, (id, error) => { completed.push(id); if (error) failures.push(id); });
  assert.equal(maximum, 4);
  assert.deepEqual(called, sources);
  assert.equal(completed.length, 30);
  assert.deepEqual(failures, ["source-2"]);
});

test("取消刷新后不启动剩余来源，不将取消误报成来源失败", async () => {
  const controller = new AbortController();
  const called: string[] = [], completed: string[] = [];
  await refreshNewsNowSources(["a", "b", "c", "d", "e"], async id => { called.push(id); controller.abort(); }, controller.signal, id => completed.push(id));
  assert.deepEqual(called, ["a"]);
  assert.deepEqual(completed, []);
});

test("嵌入消息必须匹配协议和有效进度", () => {
  const state = { total: 30, hidden: 4, refreshing: true, completed: 5, failures: [], message: "正在刷新", storageError: "" };
  assert.equal(isNewsNowWorkbenchMessage({ channel: "workbench-newsnow", version: 1, type: "state", state }), true);
  assert.equal(isNewsNowWorkbenchMessage({ channel: "other", version: 1, type: "state", state }), false);
  assert.equal(isNewsNowWorkbenchMessage({ channel: "workbench-newsnow", version: 1, type: "state", state: { ...state, completed: 31 } }), false);
});

test("NewsNow 适配器版本不匹配时明确失败，部署原样保留", async () => {
  // The adapter is plain ESM so it also runs in the standalone installation script.
  const modulePath = new URL("../scripts/lib/newsnow-adapter.mjs", import.meta.url).href;
  const { patchNewsNowClient, patchNewsNowServer } = await import(modulePath);
  assert.throws(() => patchNewsNowClient("unknown bundle", "", {}), /版本不匹配/);
  assert.throws(() => patchNewsNowServer("unknown server"), /结构不匹配/);
  const source = await readFile(new URL("../src/lib/newsnow-workbench.tsx", import.meta.url), "utf8");
  assert.match(source, /api\.cache\.set\(id, result\)/);
});

test("固定版本适配器让显式最新请求绕过短缓存，并标明失败回退", async () => {
  const { patchNewsNowServer } = await import(new URL("../scripts/lib/newsnow-adapter.mjs", import.meta.url).href);
  const source = `const latest = query.latest !== void 0 && query.latest !== "false";
      if (cache) {
        if (now - cache.updated < sources[id].interval) {
          return {
            status: "success",
            id,
            updatedTime: now,
            items: cache.items
          };
        }
      }
      return {
          status: "cache",
          id,
          updatedTime: cache.updated,
          items: cache.items
        }`;
  const patched = patchNewsNowServer(source);
  assert.match(patched, /const forceLatest = latest && \(event\.context\.disabledLogin \|\| event\.context\.user\)/);
  assert.match(patched, /if \(cache && !forceLatest\)/);
  assert.match(patched, /status: "cache",\s+id,\s+updatedTime: cache\.updated/);
  assert.match(patched, /fallbackReason: "拉取最新资讯失败，正在显示上次成功缓存。"/);
});
