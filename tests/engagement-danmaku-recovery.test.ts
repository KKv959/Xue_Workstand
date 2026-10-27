import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateEngagement, buildCommentBatchPrompt } from "../src/lib/engagement";
import { buildEngagementTransportGuard, sanitizeEngagementGenerationText, containsEngagementTransportLeak } from "../src/lib/engagement-transport";
import { resolveEngagementRecord, saveEngagementRecord, writeEngagementCache } from "../src/lib/storage";
import { writeJsonFile } from "../src/lib/storage/fs";
import { shortHash } from "../src/lib/utils";

test("链接追踪标识不进入正文或评论提示词", () => {
  const url = "https://www.douyin.com/?modal_id=7123456789012345678&video_id=1234567890";
  const text = "折叠手机 BV1xx411c7mD 7123456789012345678 1234567890";
  const guard = buildEngagementTransportGuard([url, text]);
  assert.equal(sanitizeEngagementGenerationText(text, guard), "折叠手机");
  for (const token of ["BV1xx411c7mD", "7123456789012345678", "1234567890"]) assert.equal(containsEngagementTransportLeak(token, guard), true);
  const prompt = buildCommentBatchPrompt({ source: { id: "fixture", title: text, content: text, input: url }, relatedResearch: null, platform: "douyin", requestedCount: 2, usedComments: ["1234567890"], transportGuard: guard });
  assert.doesNotMatch(prompt, /BV1xx411c7mD|7123456789012345678|1234567890|douyin\.com/);
});

test("评论批次提示词要求按真实样本混合短中长", () => {
  const prompt = buildCommentBatchPrompt({
    source: { id: "fixture", title: "折叠手机", content: "屏幕展开更大，价格也更高。" },
    relatedResearch: {
      lengthBuckets: { short: 10, medium: 60, long: 30 }, referenceSamples: [], hotComments: [],
      usedQueries: [], searchAnchors: [], searchEventTerms: [], failedQueries: [],
      relatedVideoCount: 1, relatedCommentCount: 100, freshCommentCount: 100, targetPlatformCommentCount: 100,
      matchedLibraryCommentCount: 0, replySampleCount: 0, longCommentCount: 30, sampleLibraryCount: 0,
      intentBuckets: { reaction: 100, question: 0, price: 0, comparison: 0, skeptical: 0, experience: 0, follow: 0, chatter: 0 },
      sourceStats: [], quarantinedVideoCount: 0, quarantinedCommentCount: 0, quarantinedSources: [], quarantineClassifierStatus: "not_needed",
      reusableComments: [], themes: [], phrases: [], questions: [], objections: [], recentTopics: [], legacyTopics: [],
      playerLifeAngles: [], platformAngles: [], replyAngles: [], longCommentPatterns: [], chatterAngles: [], cacheHit: false
    },
    platform: "douyin",
    requestedCount: 10,
    usedComments: []
  });
  assert.match(prompt, /短评.*10%.*中评.*60%.*长评.*30%/);
  assert.match(prompt, /至少包含.*36 字以上/);
  assert.match(prompt, /12 字以内/);
});

test("少量评论仍混合长短，单条补写不要求凑一组，缺少样本不虚报分布", () => {
  for (const requestedCount of [1, 2, 5]) {
    const prompt = buildCommentBatchPrompt({ source: { id: "fixture", title: "折叠手机", content: "屏幕展开更大。" }, relatedResearch: null, platform: "bilibili", requestedCount, usedComments: ["先看价格"] });
    assert.doesNotMatch(prompt, /真实样本长度分布/);
    if (requestedCount > 1) assert.match(prompt, /至少包含 1 条 12 字以内.*1 条 36 字以上/);
    else assert.doesNotMatch(prompt, /至少包含|本批不要把所有评论/);
  }
});

test("弹幕批次取消恢复、永久失败和两路失败落盘", async (t) => {
  const env = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "engagement-danmaku-"));
  const prompts: string[] = [];
  let mode = "success";
  let generated = 0;
  let planCalls = 0;
  let releasePlan: (() => void) | undefined;
  let releaseDanmaku: (() => void) | undefined;
  let planFinished = false;
  let activeBatches = 0;
  let maxActiveBatches = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system: string = body.messages[0].content;
    const prompt: string = body.messages[1].content;
    const reply = (value: unknown) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) } }] })
        + '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    if (system.includes("搜索计划")) {
      planCalls += 1;
      if (mode === "both") {
        reply({ queries: ["折叠手机"], sources: [{ query: "折叠手机", videoType: "实机体验", discussion: "价格取舍" }] });
        return;
      }
      if (mode === "hold-plan") await new Promise<void>((resolve) => { releasePlan = resolve; });
      planFinished = true;
      res.writeHead(401); res.end("unauthorized"); return;
    }
    if (mode === "both" && system.startsWith("为")) {
      reply(["屏幕看起来挺方便", "价格还是要再看看"]);
      return;
    }
    if (mode === "both") await new Promise<void>((resolve) => { releaseDanmaku = resolve; });
    prompts.push(prompt);
    if (mode === "benchmark") {
      activeBatches += 1;
      maxActiveBatches = Math.max(maxActiveBatches, activeBatches);
      await new Promise((resolve) => setTimeout(resolve, 40));
      activeBatches -= 1;
    }
    if (mode === "permanent" && prompts.length === 2) {
      res.writeHead(401); res.end("unauthorized"); return;
    }
    assert.doesNotMatch(prompt, /时间槽|当下内容：|使用一个允许表情|不用 emoji/);
    assert.equal(body.reasoning_effort, "low");
    const count = Number(prompt.match(/请生成 (\d+) 条弹幕/)?.[1]);
    assert.ok(count > 0 && count <= 100);
    const content = JSON.stringify(mode === "relaxed"
      ? ["[新表情]", "😂", "这台手机的展开效果真的不错", "这台手机的展开效果确实不错", "这段看得我又想换手机了".repeat(5), "[新表情]"]
      : Array.from({ length: count }, () => "反应" + shortHash(String(++generated))));
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|OPENCLI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, CHAT_API_KEY: "fixture", CHAT_MODEL: "fixture", CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_WIRE_API: "chat_completions", CHAT_FALLBACK_ENABLED: "0" });
  const url = "https://www.bilibili.com/video/BV1xx411c7mD";
  const segments = [{ startSec: 0, endSec: 40, text: "折叠手机屏幕展开更大。" }, { startSec: 400, endSec: 600, text: "但是价格是关键问题。" }];
  const input = { sourceType: "url" as const, url, includeComments: false, commentCount: 1, includeDanmaku: true, danmakuCount: 250 };
  try {
    await writeJsonFile(path.join(root, "bilibili/fixture/videos/style.json"), { id: "style", platform: "bilibili", title: "折叠手机体验", duration: 600, danmakuSamples: ["屏幕真大", "这折痕挺浅", "先看价格", "手感怎么样", "重量还行", "这个铰链有意思"] });
    await writeEngagementCache("source", shortHash(`engagement-v3:source:${url}`), { engineVersion: "engagement-v3", result: { text: segments.map((segment) => segment.text).join(""), title: "折叠手机 BV1xx411c7mD", platform: "bilibili", source: "platform_subtitle", url, resolvedUrl: url, durationSec: 600, segments } });
    await t.test("取消后只生成未完成 wave，完整恢复不重复模型请求", async () => {
      const controller = new AbortController();
      await assert.rejects(generateEngagement(input, { checkpointId: "cancel", signal: controller.signal, onProgress(progress) { if (progress.checkpointSaved) controller.abort(new Error("用户取消")); } }), /用户取消/);
      assert.equal(prompts.length, 2);
      assert.equal((await readdir(path.join(root, "engagement/.cache/pipeline"))).length, 2);
      const result = await generateEngagement(input, { checkpointId: "cancel" });
      assert.equal(prompts.length, 3, "首 wave 的两个成功批次不重算");
      assert.equal(result.record.danmaku?.items.length, 250);
      assert.equal(result.record.danmaku?.timingBasis, "none");
      assert.equal(result.record.sourceDurationSec, 600);
      assert.deepEqual(result.record.sourceSegments, segments);
      assert.ok(result.record.danmaku.items.every((item) => item.timeSec === undefined));
      assert.ok(prompts.every((prompt) => !prompt.includes("BV1xx411c7mD")));
      assert.equal((await generateEngagement(input, { checkpointId: "cancel" })).record.id, result.record.id);
      assert.equal(prompts.length, 3);
    });
    await t.test("永久失败停止后续 wave 和补齐，保留成功批次供历史补齐", async () => {
      mode = "permanent"; prompts.length = 0;
      await assert.rejects(generateEngagement(input, { checkpointId: "permanent" }), /未生成完整/);
      assert.equal(prompts.length, 2, "鉴权失败不继续第三批或外层补齐");
      const record = await resolveEngagementRecord(`run-${shortHash("permanent")}`);
      assert.equal(record.danmaku?.items.length, 100);
      assert.equal(record.fallback, true);
      assert.ok(record.danmaku?.diagnostics?.batches.some((batch) => batch.retryable === false));
      mode = "success";
      const result = await generateEngagement({ sourceType: "record", recordId: record.id, includeComments: false, commentCount: 1, includeDanmaku: true, danmakuCount: 150 });
      assert.equal(result.record.danmaku?.items.length, 250);
      assert.equal(result.record.sourceDurationSec, 600);
      assert.equal(result.record.danmaku?.timingBasis, "none");
      assert.deepEqual(result.record.sourceSegments, segments);
    });
    await t.test("评论失败仍保存弹幕，并返回真实错误", async () => {
      prompts.length = 0;
      await assert.rejects(generateEngagement({ ...input, includeComments: true, commentCount: 2, danmakuCount: 2 }, { checkpointId: "mixed" }), /鉴权|401|API Key/);
      assert.equal(planCalls, 1);
      const record = await resolveEngagementRecord(`run-${shortHash("mixed")}`);
      assert.equal(record.comments, undefined);
      assert.equal(record.danmaku?.items.length, 2);
      assert.equal(record.fallback, true);
      assert.match(record.fallbackReason || "", /鉴权|401|API Key/);
    });
    await t.test("弹幕完成后立即保存，不等待仍在规划的评论", async () => {
      mode = "hold-plan"; planFinished = false;
      let observedSaved = false;
      const timeout = setTimeout(() => releasePlan?.(), 5000);
      try {
        await assert.rejects(generateEngagement({ ...input, includeComments: true, commentCount: 2, danmakuCount: 2 }, {
          checkpointId: "early-danmaku",
          async onProgress(progress) {
            if (!progress.message.startsWith("弹幕结果已保存")) return;
            const record = await resolveEngagementRecord(`run-${shortHash("early-danmaku")}`);
            assert.equal(record.danmaku?.items.length, 2);
            assert.equal(record.comments, undefined);
            assert.equal(planFinished, false, "评论规划未结束时，弹幕已经写入历史");
            observedSaved = true;
            releasePlan?.();
          }
        }), /鉴权|401|API Key/);
        assert.equal(observedSaved, true);
        assert.equal((await resolveEngagementRecord(`run-${shortHash("early-danmaku")}`)).fallback, true);
      } finally { clearTimeout(timeout); releasePlan?.(); mode = "success"; }
    });
    await t.test("评论先保存，两路成功后保留同一历史中的全部结果", async () => {
      mode = "both";
      let observedSaved = false;
      process.env.OPENCLI_NODE_BIN = process.execPath;
      process.env.OPENCLI_SCRIPT = path.resolve("tests/fixtures/engagement-c-cli.mjs");
      process.env.OPENCLI_BROWSER_SESSION = "split-save-fixture";
      const timeout = setTimeout(() => releaseDanmaku?.(), 5000);
      try {
        const result = await generateEngagement({ sourceType: "text", text: "折叠手机的屏幕和价格取舍。", targetPlatform: "bilibili", includeComments: true, commentCount: 2, includeDanmaku: true, danmakuCount: 2 }, {
          checkpointId: "both",
          async onProgress(progress) {
            if (!progress.message.startsWith("评论结果已保存")) return;
            const record = await resolveEngagementRecord(`run-${shortHash("both")}`);
            assert.equal(record.comments?.items.length, 2);
            assert.equal(record.danmaku, undefined);
            observedSaved = true;
            releaseDanmaku?.();
          }
        });
        assert.equal(observedSaved, true);
        assert.equal(result.record.comments?.items.length, 2);
        assert.equal(result.record.danmaku?.items.length, 2);
        const record = await resolveEngagementRecord(result.record.id);
        assert.equal(record.comments?.items.length, 2);
        assert.equal(record.danmaku?.items.length, 2);
      } finally { clearTimeout(timeout); releaseDanmaku?.(); mode = "success"; }
    });
    await t.test("允许表情、相似观点、长反应和少量复读，不触发补齐", async () => {
      mode = "relaxed"; prompts.length = 0;
      const result = await generateEngagement({ ...input, danmakuCount: 6 }, { checkpointId: "relaxed" });
      assert.equal(result.record.danmaku?.items.length, 6);
      assert.equal(prompts.length, 1);
      assert.equal(result.record.danmaku?.diagnostics?.rejectedCount, 0);
      assert.ok(result.record.danmaku?.items.some((item) => item.text === "😂"));
      assert.equal(result.record.danmaku?.items.filter((item) => item.text === "[新表情]").length, 2);
      mode = "success";
    });
    await t.test("250 条弹幕只发三次请求，最多两批并发", async () => {
      mode = "benchmark"; prompts.length = 0; maxActiveBatches = 0;
      const startedAt = Date.now();
      const result = await generateEngagement(input, { checkpointId: "benchmark" });
      assert.equal(result.record.danmaku?.items.length, 250);
      assert.equal(prompts.length, 3);
      assert.equal(maxActiveBatches, 2);
      assert.deepEqual(result.record.danmaku?.diagnostics?.batches.map((batch) => batch.requestedCount), [100, 100, 50]);
      t.diagnostic(`模拟每次模型响应 40ms：250 条、3 次调用、2 轮耗时 ${Date.now() - startedAt}ms；旧链路需 16 次调用、8 轮。`);
      mode = "success";
    });
    await t.test("历史带时间弹幕补齐后保留原时间，新弹幕不编时间", async () => {
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...base } = await resolveEngagementRecord(`run-${shortHash("mixed")}`);
      void _id; void _createdAt; void _updatedAt;
      const historical = await saveEngagementRecord({ ...base,
        options: { ...base.options, includeComments: false, danmakuCount: 4 },
        danmaku: { ...base.danmaku!, requestedCount: 4, timingBasis: "source_segments", items: [{ id: "old", timeSec: 15, text: "以前的弹幕" }] }
      }, { idempotencyKey: "historical" });
      const result = await generateEngagement({ sourceType: "record", recordId: historical.id, includeComments: false, commentCount: 1, includeDanmaku: true, danmakuCount: 3 });
      assert.equal(result.record.danmaku?.items.length, 4);
      assert.equal(result.record.danmaku?.items[0].timeSec, 15);
      assert.ok(result.record.danmaku?.items.slice(1).every((item) => item.timeSec === undefined));
    });
    await t.test("幂等保存按两侧独立保留更多结果", async () => {
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...base } = await resolveEngagementRecord(`run-${shortHash("mixed")}`);
      void _id; void _createdAt; void _updatedAt;
      const comments = { generatedAt: new Date().toISOString(), requestedCount: 2, actualCount: 2, usedModel: "fixture", fallback: false, items: ["第一条评论", "第二条评论"].map((text, index) => ({ id: String(index), text, platform: "bilibili" as const, origin: "ai_generated" as const })) };
      await saveEngagementRecord(base, { idempotencyKey: "merge" });
      const merged = await saveEngagementRecord({ ...base, comments, danmaku: undefined }, { idempotencyKey: "merge" });
      assert.equal(merged.comments?.items.length, 2);
      assert.equal(merged.danmaku?.items.length, 2);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
