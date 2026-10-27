import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateEngagement } from "../src/lib/engagement";
import { buildEngagementCommentResearch } from "../src/lib/engagement-research";

test("B站正式评论入口、恢复和采集失败均不请求抖音", async () => {
  const env = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "engagement-bilibili-platform-"));
  const eventFile = path.join(root, "events.jsonl");
  let modelCalls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls += 1;
    const planning = body.messages[0].content.includes("搜索计划");
    if (!planning) {
      assert.match(body.messages[1].content, /B站参考句子/);
      assert.doesNotMatch(body.messages[1].content, /抖音参考句子/);
    }
    const content = JSON.stringify(planning
      ? { queries: ["折叠手机"], sources: [{ query: "折叠手机", videoType: "实机体验", discussion: "使用取舍" }] }
      : ["这个屏幕展开挺方便", "重量如何", "价格还要再看看"]);
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content } }] })
      + '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|OPENCLI_|COMMENT_TEST_)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    STYLE_LIBRARY_DIR: root,
    CHAT_API_KEY: "fixture", CHAT_MODEL: "fixture", CHAT_WIRE_API: "chat_completions",
    CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_FALLBACK_ENABLED: "0",
    OPENCLI_NODE_BIN: process.execPath, OPENCLI_SCRIPT: path.resolve("tests/fixtures/engagement-c-cli.mjs"),
    OPENCLI_BROWSER_SESSION: "bilibili-platform-fixture", COMMENT_TEST_EVENTS: eventFile,
    COMMENT_TEST_FAIL_PLATFORM: "douyin"
  });
  const events = async () => (await readFile(eventFile, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { platform: string });
  try {
    const input = {
      sourceType: "text" as const, title: "折叠手机", text: "折叠手机的屏幕、重量和价格取舍。",
      targetPlatform: "bilibili" as const, includeComments: true, commentCount: 3, includeDanmaku: false, danmakuCount: 0
    };
    const result = await generateEngagement(input, { checkpointId: "bilibili-only" });
    assert.equal(result.record.comments?.items.length, 3);
    assert.deepEqual(result.record.comments.diagnostics?.relatedResearch?.sourceStats?.map((row) => row.source), ["bilibili"]);
    assert.equal(result.record.comments.diagnostics?.relatedResearch?.capturedCommentCount, 200);
    const collected = await events();
    assert.ok(collected.length > 0);
    assert.ok(collected.every((row) => row.platform === "bilibili"));
    const callsBeforeResume = modelCalls;
    assert.equal((await generateEngagement(input, { checkpointId: "bilibili-only" })).record.id, result.record.id);
    assert.equal(modelCalls, callsBeforeResume);
    assert.deepEqual(await events(), collected);

    process.env.COMMENT_TEST_FAIL_PLATFORM = "bilibili";
    await assert.rejects(buildEngagementCommentResearch({
      fullText: "另一份折叠手机素材", summary: "", topic: "折叠手机", subjects: [], keyFacts: [],
      discussionAngles: [], skepticalAngles: [], anchorTerms: []
    }, { platform: "bilibili" }), /B站调研没有抓到/);
    assert.ok((await events()).length > collected.length);
    assert.ok((await events()).every((row) => row.platform === "bilibili"), "B站失败时也不能转采抖音");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
