import assert from "node:assert/strict";
import test from "node:test";
import { runCommentPipeline, type CommentPipelineCheckpoint } from "../src/lib/engagement-pipeline";
import { collectCommentSources, createCommentCollectionBudget } from "../src/lib/engagement-source-selection";
import { selectRelatedCommentVideos } from "../src/lib/opencli-normalizers";
import { isResumableJobKind } from "../src/lib/job-persistence";
import { selectCommentSamples } from "../src/lib/engagement";
import { buildEngagementTransportGuard } from "../src/lib/engagement-transport";
import { findTaskJob } from "../src/app/assets/_hooks/useEngagementGeneration";
import type { JobRecord } from "../src/lib/types";

function checkpoint() {
  return { rounds: [], batches: [], exhausted: false } as unknown as CommentPipelineCheckpoint;
}

test("旧终态任务不挡住同范围的新任务与快速完成的重试", () => {
  const failed = { id: "old", kind: "engagement", status: "failed", createdAt: "2026-10-06T00:00:00Z" } as JobRecord;
  const running = { ...failed, id: "new", status: "running", createdAt: "2026-10-06T00:01:00Z" } as JobRecord;
  assert.equal(findTaskJob([failed, running], failed.id, "engagement", () => true)?.id, running.id);
  assert.equal(findTaskJob([failed, { ...running, status: "completed" }], failed.id, "engagement", () => true)?.id, running.id);
  assert.equal(findTaskJob([failed, running], running.id, "engagement", () => false)?.id, running.id);
});

test("旧检查点恢复先过滤污染与重复，再按实际缺口补写", async () => {
  const state = checkpoint();
  const candidates = ["价格有点高", "屏幕确实大", "屏幕确实大", "https://example.com"];
  state.rounds = [{ requestedCount: 4, batchIds: [0] }];
  state.batches = [{ index: 0, requestedCount: 4, model: "fixture", attempts: 1, candidates, review: candidates.map((text) => ({ text, keep: true })) }];
  const generated: number[] = [];
  const guard = buildEngagementTransportGuard([]);
  const result = await runCommentPipeline({ state, count: 4, save: async () => {},
    select: (values, reviewed) => selectCommentSamples(values, guard, 4, reviewed).items,
    async generate(batch) {
      generated.push(batch.requestedCount);
      return { candidates: ["续航能撑多久", "铰链手感不错"], model: "fixture", attempts: 1 };
    }
  });
  assert.deepEqual(generated, [2]);
  assert.deepEqual(result, ["价格有点高", "屏幕确实大", "续航能撑多久", "铰链手感不错"]);
});

test("无审核和筛选的正式模式直接保存原始候选，补量与恢复保留重复", async () => {
  const state = checkpoint();
  const generated: number[] = [];
  const run = () => runCommentPipeline({ state, count: 4, save: async () => {},
    async generate(batch) {
      generated.push(batch.requestedCount);
      return { candidates: batch.index === 0 ? ["啊", "一样", "一样"] : ["[赞]"], model: "test", attempts: 1 };
    }
  });
  assert.deepEqual(await run(), ["啊", "一样", "一样", "[赞]"]);
  assert.deepEqual(generated, [4, 1]);
  assert.deepEqual(await run(), ["啊", "一样", "一样", "[赞]"]);
  assert.deepEqual(generated, [4, 1], "已完成恢复不得重新生成");
});

test("首轮整组生成和整组质检，缺口仅补一轮", async () => {
  const state = checkpoint();
  const generated: number[] = [];
  const reviewed: Array<{ count: number; kept: number }> = [];
  const result = await runCommentPipeline({
    state, count: 70, save: async () => {},
    async generate(batch) {
      generated.push(batch.requestedCount);
      return { candidates: Array.from({ length: batch.requestedCount }, (_, i) => `评论${batch.index}-${i}`), model: "test", attempts: 1 };
    },
    async review(comments, kept) {
      reviewed.push({ count: comments.length, kept: kept.length });
      return comments.map((text, index) => ({ text, keep: reviewed.length > 1 || index < 50 }));
    },
    select: (comments) => comments
  });
  assert.equal(result.length, 70);
  assert.deepEqual(generated, [70, 20]);
  assert.deepEqual(reviewed, [{ count: 70, kept: 0 }, { count: 20, kept: 50 }]);
});

test("审核失败后保留整组候选，重试不重新生成", async () => {
  const state = checkpoint();
  let generationCalls = 0;
  await assert.rejects(runCommentPipeline({
    state, count: 20, save: async () => {},
    async generate(batch) {
      generationCalls += 1;
      return { candidates: Array.from({ length: batch.requestedCount }, (_, i) => `评论${i}`), model: "test", attempts: 1 };
    },
    review: async () => { throw new Error("审核断线"); },
    select: (comments) => comments
  }), /审核断线/);
  assert.equal(state.batches[0].candidates?.length, 20);
  const result = await runCommentPipeline({
    state, count: 20, save: async () => {},
    generate: async () => { generationCalls += 1; throw new Error("不应调用"); },
    review: async (comments) => comments.map((text) => ({ text, keep: true })),
    select: (comments) => comments
  });
  assert.equal(result.length, 20);
  assert.equal(generationCalls, 1);
});

test("取消时保存已完成候选，恢复后只续做质检", async () => {
  const state = checkpoint();
  const controller = new AbortController();
  let saved = "";
  await assert.rejects(runCommentPipeline({
    state, count: 1, signal: controller.signal,
    save: async () => { saved = JSON.stringify(state); },
    generate: async () => ({ candidates: ["已完成候选"], model: "test", attempts: 1 }),
    async review() { controller.abort(new Error("用户取消")); throw controller.signal.reason; },
    select: (comments) => comments
  }), /用户取消/);
  const restored = JSON.parse(saved) as CommentPipelineCheckpoint;
  assert.deepEqual(restored.batches[0].candidates, ["已完成候选"]);
  const result = await runCommentPipeline({
    state: restored, count: 1, save: async () => {},
    generate: async () => { throw new Error("不应重新生成"); },
    review: async (comments) => comments.map((text) => ({ text, keep: true })),
    select: (comments) => comments
  });
  assert.deepEqual(result, ["已完成候选"]);
});

test("候选视频失败时有限替换，最多保留两个有效来源", async () => {
  const attempts: string[] = [];
  const result = await collectCommentSources({
    candidates: ["空视频", "视频A", "视频B", "不应读取"], sourceTarget: 2,
    async read(video) { attempts.push(video); return video === "空视频" ? [] : [video]; },
    count: (rows) => rows.length
  });
  assert.deepEqual(attempts, ["空视频", "视频A", "视频B"]);
  assert.deepEqual(result.videos, ["视频A", "视频B"]);
});

test("两条评论也保留，但不足目标继续候选；跨平台重复不充数且最多八次", async () => {
  const budget = createCommentCollectionBudget(600);
  const attempts: string[] = [];
  const results = await Promise.all(["抖音", "B站"].map((platform) => collectCommentSources({
    candidates: [0, 1, 2, 3], sourceTarget: 2, budget,
    count: (rows: string[]) => rows.length,
    async read(index) {
      attempts.push(platform + index);
      const rows = index < 2 ? ["共同评论", "另一条共同评论"]
        : Array.from({ length: 200 }, (_, i) => platform + index + "原评" + i);
      budget.add(rows);
      await Promise.resolve();
      return rows;
    }
  })));
  assert.ok(budget.count >= 600);
  assert.ok(attempts.length <= 8);
  assert.ok(results.every((result) => result.videos.length > 2));
  assert.ok(results.every((result) => result.results[0].length === 2));
});

test("达到总语料目标后仍覆盖另一个平台的首批，停止额外候选；取消不继续", async () => {
  const budget = createCommentCollectionBudget(2);
  budget.add(["已有一", "已有二"]);
  const attempts: number[] = [];
  await collectCommentSources({
    candidates: [1, 2, 3, 4], sourceTarget: 2, budget, count: (rows: string[]) => rows.length,
    async read(index) { attempts.push(index); return ["语料"]; }
  });
  assert.deepEqual(attempts, [1, 2]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectCommentSources({
    candidates: [1], sourceTarget: 2, budget, signal: controller.signal,
    read: async () => { throw new Error("不应调用"); }, count: () => 0
  }), { name: "AbortError" });
});

test("合并检索结果去重，兼顾方向和作者", () => {
  const video = (id: string, author: string, heat = 0) => ({ id, title: id, author, heat });
  const selected = selectRelatedCommentVideos([
    { query: "方向一", videos: [video("A", "甲"), video("B", "甲", 999)] },
    { query: "方向二", videos: [video("A", "甲"), video("C", "乙")] }
  ], 2, (a, b) => b.heat - a.heat);
  assert.deepEqual(selected.map((row) => row.id), ["A", "C"]);
});

test("有检查点的纯评论任务自动恢复，混合弹幕任务保持手动恢复", () => {
  const input = { kind: "engagement" as const, checkpointId: "task", input: { sourceType: "text" as const, text: "正文", includeComments: true, commentCount: 50, includeDanmaku: false, danmakuCount: 0 } };
  assert.equal(isResumableJobKind("engagement", input), true);
  assert.equal(isResumableJobKind("engagement", { ...input, checkpointId: undefined }), false);
  assert.equal(isResumableJobKind("engagement", { ...input, input: { ...input.input, includeDanmaku: true } }), false);
});
