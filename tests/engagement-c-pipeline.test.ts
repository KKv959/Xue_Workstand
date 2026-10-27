import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateEngagement } from "../src/lib/engagement";
import { buildEngagementCommentResearch } from "../src/lib/engagement-research";
import { getBilibiliExpandedComments } from "../src/lib/opencli-bilibili-comments";
import { writeJsonFile } from "../src/lib/storage/fs";

test("C 正式入口双平台各取200条，固定参考补足150条且不重跑规划采集", async () => {
  const env = { ...process.env }; const root = await mkdtemp(path.join(tmpdir(), "comment-c-pipeline-"));
  let plans = 0; let generated = 0; let reviewCalls = 0;
  let limited = false;
  const prompts: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const system: string = body.messages[0].content; const prompt: string = body.messages[1].content;
    let content: string;
    if (system.includes("搜索计划")) {
      plans += 1; content = JSON.stringify({ sources: [{ query: "折叠手机", videoType: "实机体验", discussion: "取舍" }, { query: "手机屏幕", videoType: "使用体验", discussion: "屏幕" }], queries: ["折叠手机", "手机屏幕"] });
    } else if (system.startsWith("为")) {
      prompts.push(prompt); const count = Number(prompt.match(/输出包含 (\d+) 个字符串/)?.[1]); assert.ok(count > 0);
      const returnedCount = limited ? 1 : prompts.length === 1 ? count - 3 : count;
      const comments = Array.from({ length: returnedCount }, () => "想问一下<br>这个体验细节" + (++generated));
      if (!limited && prompts.length === 1) comments.splice(0, 7, "啊", "[赞]", "https://example.com/test", "@张三", "很".repeat(150), "相同原句", "相同原句");
      content = JSON.stringify(comments);
    } else {
      assert.match(system, /检查新生成/); reviewCalls += 1;
      const payload = JSON.parse(prompt) as { comments: Array<{ id: number; text: string }>; existingComments: string[]; article: string };
      if (!limited) assert.ok(payload.article.includes("#十年逐光"), "审核必须收到生成时的标题和话题标签");
      assert.ok(payload.comments.length <= 200);
      const firstPass = reviewCalls === 1;
      const keep = payload.comments.filter((row) => limited ? row.id === 0 : !firstPass || row.id < 10);
      content = JSON.stringify({ keep: keep.map((row) => row.id), reject: payload.comments.filter((row) => !keep.includes(row)).map((row) => ({ id: row.id, reason: "本轮重复观点" })) });
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|OPENCLI_)/.test(key)) delete process.env[key];
  const eventFile = path.join(root, "events.jsonl");
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, CHAT_API_KEY: "secret-token-for-audit-test", CHAT_MODEL: "fixture", CHAT_WIRE_API: "chat_completions", CHAT_BASE_URL: "http://127.0.0.1:" + address.port, CHAT_FALLBACK_ENABLED: "0", OPENCLI_NODE_BIN: process.execPath, OPENCLI_SCRIPT: path.resolve("tests/fixtures/engagement-c-cli.mjs"), OPENCLI_BROWSER_SESSION: "comment-c-fixture", COMMENT_TEST_EVENTS: eventFile });
  try {
    const request = { sourceType: "text" as const, title: "折叠手机 #十年逐光", text: "折叠手机的价格和使用取舍，屏幕展开更大。", targetPlatform: "douyin" as const, includeComments: true, commentCount: 150, includeDanmaku: false, danmakuCount: 0 };
    const result = await generateEngagement(request, { checkpointId: "fixture-run" });
    assert.equal(result.record.comments?.items.length, 150);
    assert.ok(result.record.comments.items.every((item) => item.platform === "douyin" && item.origin === "ai_generated"));
    assert.equal(plans, 1);
    assert.equal(prompts.length, 2, "模型少返回三条时仅补一次缺口");
    assert.equal(reviewCalls, 0, "正式入口不得调用生成后 AI 审核");
    assert.match(prompts[1], /补足缺少的 9 条评论/);
    const priorComments = JSON.parse(prompts[1].split("<已生成评论>\n")[1].split("\n</已生成评论>")[0]);
    assert.deepEqual(priorComments, result.record.comments.items.slice(0, 141).map((item) => item.text), "补量只接收已筛选的可用评论");
    assert.equal(result.record.comments.items.filter((item) => item.text === "相同原句").length, 1);
    assert.ok(result.record.comments.items.every((item) => !/https?:|@|<br>/.test(item.text) && item.text.length <= 140));
    assert.equal(result.record.comments.diagnostics?.generation?.transportRejectedCount, 1);
    assert.equal(result.record.comments.diagnostics?.generation?.nearDuplicateRejectedCount, 1);
    assert.equal(result.record.comments.diagnostics?.generation?.outputReview, undefined);
    assert.ok(prompts[0].includes("<当前视频>"));
    assert.ok(!prompts[0].includes("<已生成评论>"));
    assert.doesNotMatch(prompts[0], /先在心里想清楚|每条必须有独立触发点/);
    assert.equal(result.record.comments?.diagnostics?.relatedResearch?.capturedCommentCount, 400);
    assert.ok((result.record.comments?.diagnostics?.relatedResearch?.voiceReferences?.length || 0) > 80);
    assert.equal(result.record.comments?.diagnostics?.relatedResearch?.review, undefined);
    assert.deepEqual(result.record.comments?.diagnostics?.relatedResearch?.reusableComments, []);
    const researchDir = path.join(root, "engagement", ".cache", "research");
    const researchFiles = await readdir(researchDir);
    const researchCache = JSON.parse(await readFile(path.join(researchDir, researchFiles[0]), "utf8"));
    assert.equal(researchCache.research.capturedSamples.length, 400);
    assert.ok(researchCache.research.referenceSamples.length > 80);
    assert.ok(researchCache.research.referenceTextChars <= 12000);
    assert.equal(researchCache.research.collectionCoverage.targetReached, false);
    assert.match(researchCache.research.summaryError, /400\/600/);
    assert.ok(researchCache.research.collectionSources.every((source: { collectionAttempts: Array<{ stopReason: string; pages: unknown[] }> }) => source.collectionAttempts.every((attempt) => attempt.stopReason === "target_reached" && attempt.pages.length === 4)));
    assert.equal(researchCache.research.collectionSources.length, 2);
    assert.ok(researchCache.research.collectionSources.every((source: { videos: unknown[] }) => source.videos.length > 0 && source.videos.length <= 2));
    const auditDir = path.join(root, "engagement", ".cache", "model-calls");
    const auditFiles = await readdir(auditDir);
    assert.equal(auditFiles.length, 3, "只记录规划与两次生成，不产生审核调用");
    const auditRecords = await Promise.all(auditFiles.map(async (file) => JSON.parse(await readFile(path.join(auditDir, file), "utf8"))));
    assert.ok(auditRecords.every((record) => record.status === "completed" && record.messages.length === 2 && record.elapsedMs >= 0));
    assert.doesNotMatch(JSON.stringify(auditRecords), /secret-token-for-audit-test|127\.0\.0\.1/);
    const generationMessage = auditRecords.find((record) => record.policy === "comment_generate").messages[1].content;
    assert.ok(generationMessage.includes("视频标题（含话题标签）：折叠手机 #十年逐光"));
    assert.ok(auditRecords.every((record) => record.policy !== "comment_output_review"));
    const promptReferences = JSON.parse(generationMessage.split("以下是按来源分组的抓取原评。\n")[1].split("\n</表达参考>")[0]);
    assert.equal(promptReferences.length, 2);
    assert.equal(promptReferences.flatMap((group: { comments: string[] }) => group.comments).length, researchCache.research.referenceSamples.length);
    assert.deepEqual(promptReferences.flatMap((group: { comments: string[] }) => group.comments).sort(), researchCache.research.referenceSamples.map((sample: { text: string }) => sample.text).sort(), "提示词保留全部所选原话，不概括或改写");
    const generatedBeforeResume = generated;
    await writeJsonFile(path.join(root, "settings/ai-models.json"), { schemaVersion: 1, revision: 1, updatedAt: null, overrides: { comment_output_review: { model: "unused-old-review-model", effort: "high" } } });
    const resumed = await generateEngagement(request, { checkpointId: "fixture-run" });
    assert.equal(resumed.record.id, result.record.id);
    assert.equal(generated, generatedBeforeResume, "已完成批次恢复时不能重新请求模型");
    assert.equal(plans, 1, "检查点恢复不重新规划或采集");
    const restarted = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      'import { generateEngagement } from "./src/lib/engagement.ts"; const result = await generateEngagement(' + JSON.stringify(request) + ', { checkpointId: "fixture-run" }); process.stdout.write(JSON.stringify({id:result.record.id,count:result.record.comments.items.length}));'
    ], { env: process.env, timeout: 15_000 });
    assert.deepEqual(JSON.parse(restarted.stdout), { id: result.record.id, count: 150 });
    assert.equal(generated, generatedBeforeResume, "跨进程恢复也不能重新生成");
    const events = (await readFile(eventFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((row) => row.kind === "search").length, 4);
    for (const platform of ["douyin", "bilibili"]) assert.deepEqual(events.filter((row) => row.kind === "search" && row.platform === platform).map((row) => row.query), ["折叠手机", "手机屏幕"]);
    assert.equal(events.filter((row) => row.path === "/x/v2/reply/wbi/main").length, 4);
    assert.equal(events.filter((row) => row.path === "/aweme/v1/web/comment/list/").length, 4);
    const brief = { fullText: "另一份素材", summary: "", topic: "", subjects: [], keyFacts: [], discussionAngles: [], skepticalAngles: [], anchorTerms: [] };
    process.env.COMMENT_TEST_CORPUS = "sparse";
    const expanded = await buildEngagementCommentResearch({ ...brief, fullText: "先命中少量评论的视频" }, { platform: "douyin" });
    assert.ok(expanded.collectionCoverage!.uniqueCount >= 600);
    assert.equal(expanded.collectionCoverage!.targetReached, true);
    assert.ok(expanded.collectionCoverage!.attemptedVideoCount <= 8);
    assert.ok(expanded.collectionCoverage!.attemptedVideoCount > 4);
    assert.ok(expanded.collectionSources!.every((source) => source.videos.length > 2));
    const attempts = expanded.collectionSources!.flatMap((source) => source.collectionAttempts || []);
    assert.ok(attempts.some((attempt) => attempt.collectedCount === 2 && attempt.stopReason === "exhausted"));
    assert.ok(attempts.some((attempt) => attempt.collectedCount === 200 && attempt.stopReason === "target_reached" && attempt.pages.length === 4));
    assert.ok(expanded.referenceSamples!.length > 80);
    delete process.env.COMMENT_TEST_CORPUS;
    process.env.COMMENT_TEST_FAIL_PLATFORM = "bilibili";
    const partial = await buildEngagementCommentResearch(brief, { platform: "douyin" });
    assert.ok(partial.hotComments.length > 0); assert.match(partial.summaryError || "", /B站/);
    assert.equal(partial.sourceStats.find((row) => row.source === "bilibili")?.status, "failed");
    assert.match(partial.collectionSources?.find((row) => row.source === "bilibili")?.error || "", /评论总数核验失败/);
    const before = plans; assert.equal((await buildEngagementCommentResearch(brief, { platform: "douyin" })).cacheHit, true); assert.equal(plans, before);
    limited = true;
    const generationCallsBefore = prompts.length;
    await assert.rejects(generateEngagement({ sourceType: "text", title: "折叠手机 #十年逐光", text: "折叠手机的价格和使用取舍，屏幕展开更大。", targetPlatform: "douyin", includeComments: true, commentCount: 5, includeDanmaku: false, danmakuCount: 0 }), /互动素材未生成完整/);
    assert.equal(prompts.length - generationCallsBefore, 2, "首轮加一轮补写后必须停止");
    assert.equal(plans, before, "不足时不重新规划或采集");
    const records = await Promise.all((await readdir(path.join(root, "engagement"))).filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await readFile(path.join(root, "engagement", file), "utf8"))));
    const partialRecord = records.find((record) => record.comments?.requestedCount === 5);
    assert.equal(partialRecord?.comments.actualCount, 2);
    assert.equal(partialRecord?.comments.partial, true);
    const consistency = JSON.parse(execFileSync(process.execPath, ["scripts/check-library-consistency.mjs"], { encoding: "utf8", env: process.env }));
    assert.equal(consistency.issueCount, 0, "完整结果与部分结果保存后，临时素材库必须保持一致");
    delete process.env.COMMENT_TEST_FAIL_PLATFORM;
    process.env.COMMENT_TEST_BILI_MODE = "stuck";
    await assert.rejects(getBilibiliExpandedComments("BV1xx411c7mD", 200), /游标重复/);
    const cacheDir = path.join(root, "engagement", ".cache", "research");
    for (const file of await readdir(cacheDir)) {
      const cachePath = path.join(cacheDir, file);
      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      assert.equal(cache.schemaVersion, 1);
      await writeJsonFile(cachePath, { ...cache, research: { ...cache.research, hotComments: null } });
    }
    await assert.rejects(buildEngagementCommentResearch(brief, { platform: "douyin" }), /缓存结构损坏/);
    assert.equal(plans, before, "缓存损坏不能静默重跑规划和采集");
    const pipelineDir = path.join(root, "engagement", ".cache", "pipeline");
    for (const file of await readdir(pipelineDir)) {
      const checkpointPath = path.join(pipelineDir, file);
      const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
      saved.batches[0].index = 99;
      await writeJsonFile(checkpointPath, saved);
    }
    await assert.rejects(generateEngagement(request, { checkpointId: "fixture-run" }), /检查点损坏/);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
