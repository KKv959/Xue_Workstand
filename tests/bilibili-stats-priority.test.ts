import { mapWithConcurrency } from "../src/lib/concurrency";
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBilibiliCommentRows,
  resolveBilibiliStatsFieldSources
} from "../src/lib/opencli-bilibili";

test("B站公开接口包含统计字段时不等待 OpenCLI", async () => {
  let opencliCalls = 0;
  const result = await resolveBilibiliStatsFieldSources(
    async () => ({ title: "测试视频", stat: { view: 12, like: 3 } }),
    async () => {
      opencliCalls += 1;
      return { view: 99 };
    }
  );

  assert.equal(opencliCalls, 0);
  assert.equal(result.metadata.view, 12);
  assert.equal(result.metadata.like, 3);
});

test("B站公开接口失败时才调用 OpenCLI 兜底", async () => {
  let opencliCalls = 0;
  const result = await resolveBilibiliStatsFieldSources(
    async () => {
      throw new Error("公开接口暂时不可用");
    },
    async () => {
      opencliCalls += 1;
      return { view: 21, like: 5 };
    }
  );

  assert.equal(opencliCalls, 1);
  assert.equal(result.metadata.view, 21);
  assert.equal(result.metadata.like, 5);
  assert.equal(result.publicResult.status, "rejected");
});

test("B站评论优先使用官方接口，不调用 OpenCLI", async () => {
  const calls: string[] = [];
  const rows = await resolveBilibiliCommentRows(
    async () => {
      calls.push("public");
      return ["官方评论"];
    },
    async () => {
      calls.push("opencli");
      return ["OpenCLI 评论"];
    }
  );

  assert.deepEqual(rows, ["官方评论"]);
  assert.deepEqual(calls, ["public"]);
});

test("B站官方评论为空或失败时再调用 OpenCLI", async () => {
  const emptyCalls: string[] = [];
  const fromEmpty = await resolveBilibiliCommentRows(
    async () => {
      emptyCalls.push("public");
      return [];
    },
    async () => {
      emptyCalls.push("opencli");
      return ["兜底评论"];
    }
  );
  assert.deepEqual(fromEmpty, ["兜底评论"]);
  assert.deepEqual(emptyCalls, ["public", "opencli"]);

  const failedCalls: string[] = [];
  const fromFailure = await resolveBilibiliCommentRows(
    async () => {
      failedCalls.push("public");
      throw new Error("限流");
    },
    async () => {
      failedCalls.push("opencli");
      return ["兜底评论"];
    }
  );
  assert.deepEqual(fromFailure, ["兜底评论"]);
  assert.deepEqual(failedCalls, ["public", "opencli"]);
});

test("B站评论采集最多同时运行 6 个视频任务", async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = mapWithConcurrency(Array.from({ length: 8 }, (_, index) => index), 6, async (index) => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return index;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peak, 6);
  release();
  assert.deepEqual(await running, [0, 1, 2, 3, 4, 5, 6, 7]);
});
