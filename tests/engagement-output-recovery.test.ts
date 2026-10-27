import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateCommentBatch, generateEngagement, parseStringArray, reviewGeneratedComments } from "../src/lib/engagement";

test("完整的逐行 JSON 字符串也可恢复为评论，不把说明或损坏内容当评论", () => {
  const values = ["电子茅台，那我买回来是用还是供着[笑哭]", '先问一句：\"多少钱\"？', "手机里的反斜杠 \\ 也保留"];
  for (const text of [JSON.stringify(values), JSON.stringify({ comments: values }),
    values.map((v) => JSON.stringify(v)).join("\n"),
    "```json\n" + values.map((v) => JSON.stringify(v) + ",").join("\n") + "\n```"]) {
    assert.deepEqual(parseStringArray(text), values);
  }
  assert.deepEqual(parseStringArray('"只剩一条也能补齐"'), ["只剩一条也能补齐"]);
  assert.deepEqual(parseStringArray(JSON.stringify(["第一槽", "第一槽", "", 42, "第五槽"]), { preservePositions: true }), ["第一槽", "第一槽", "", "", "第五槽"]);
  assert.deepEqual(parseStringArray('"第一槽"\n"第二槽"', { preservePositions: true }), []);
  assert.deepEqual(parseStringArray('1. 第一条评论\n2. 第二条评论\n3. 第三条评论'), ["第一条评论", "第二条评论", "第三条评论"]);
  for (const text of ["模型异常", '说明内容\n"不能误当成完整列表"', '"一条完整的"\n"第二条没有闭合', '["数组没有结束"', "[]"]) {
    assert.deepEqual(parseStringArray(text), []);
  }
});

test("评论生成与质检只恢复失败批次，失败有界且用户取消立即终止", async (t) => {
  const env = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "engagement-output-recovery-"));
  type Request = { messages: Array<{ role: string; content: string }>; stream: boolean };
  const received: Request[] = [];
  let mode = "recover";
  let onRequest: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body: Request = JSON.parse(raw);
    received.push(body);
    onRequest?.();
    if (mode === "hang") return;
    if (mode === "unauthorized") { res.writeHead(401); res.end("unauthorized"); return; }
    if (mode === "network" || (mode === "recover" && received.length === 2)) { req.socket.destroy(); return; }
    let content: string;
    if (mode === "generate") {
      content = received.length === 1 ? "没有按格式返回评论" : '"第一条评论"\n"第二条评论[笑哭]"';
    } else {
      const payload = JSON.parse(body.messages[1].content) as { article: string; existingComments: string[]; comments: Array<{ id: number; text: string }> };
      content = JSON.stringify({
        keep: payload.comments.filter((row) => !payload.existingComments.includes(row.text)).map((row) => row.id),
        reject: payload.comments.filter((row) => payload.existingComments.includes(row.text)).map((row) => ({ id: row.id, reason: "与已保留评论重复" }))
      });
      if (mode === "bad" || (mode === "format" && received.length === 1)) content = '{"keep":[0],"reject":[{"id":0,"reason":"编号冲突"}]}';
      if (mode === "empty-always" || (mode === "empty" && received.length === 1)) content = "";
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, CHAT_API_KEY: "fixture", CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_MODEL: "fixture-model", CHAT_WIRE_API: "chat_completions", CHAT_FALLBACK_ENABLED: "0" });
  const switchMode = (next: string) => { mode = next; received.length = 0; onRequest = undefined; };
  const progress: string[] = [];
  const review = () => reviewGeneratedComments(["第一条", "第二条"], "完整原文", [], undefined, (message) => { progress.push(message); });
  try {
    await t.test("第二批断线只重试第二批，保留首批判断与跨批去重语境", async () => {
      const comments = Array.from({ length: 51 }, (_, i) => `评论${i}`);
      comments[48] = comments[0];
      const result = await reviewGeneratedComments(comments, "完整原文", ["历史评论"]);
      assert.equal(received.length, 3);
      const payloads = received.map((r) => JSON.parse(r.messages[1].content));
      assert.deepEqual(payloads.map((p) => p.comments.length), [48, 3, 3]);
      assert.deepEqual(payloads[1], payloads[2]);
      assert.deepEqual(payloads[1].existingComments, ["历史评论", ...comments.slice(0, 48)]);
      assert.deepEqual(result.decisions.map((r) => r.id), Array.from({ length: 51 }, (_, i) => i));
      assert.equal(result.decisions[48].keep, false);
      assert.equal(result.reviewedCount, 51);
      assert.equal(result.rejectedCount, 1);
      assert.ok(received.every((r) => r.stream));
    });
    await t.test("缺漏或冲突编号自动纠正一次，不把未知项直接放行", async () => {
      switchMode("format");
      assert.equal((await review()).reviewedCount, 2);
      assert.equal(received.length, 2);
      assert.match(received[1].messages[0].content, /上一次响应格式不完整/);
      switchMode("bad");
      await assert.rejects(review, /质检/);
      assert.equal(received.length, 2);
    });
    await t.test("完整流的空内容允许恢复一次，连续空内容仍显式失败", async () => {
      switchMode("empty");
      assert.equal((await review()).reviewedCount, 2);
      assert.equal(received.length, 2);
      switchMode("empty-always");
      await assert.rejects(review, /没有返回/);
      assert.equal(received.length, 2);
    });
    await t.test("生成格式失败只重写当前批，逐行引号输出可直接解析", async () => {
      switchMode("generate");
      const result = await generateCommentBatch([{ role: "system", content: "生成测试" }, { role: "user", content: "输入正文" }], 2);
      assert.deepEqual(result.batchParsed, ["第一条评论", "第二条评论[笑哭]"]);
      assert.equal(result.attempts, 2);
      assert.equal(received.length, 2);
      assert.match(received[1].messages[2].content, /完整 JSON 数组/);
    });
    await t.test("连续断网有限重试，鉴权失败不做无效重试", async () => {
      switchMode("network");
      await assert.rejects(review, /连接异常/);
      assert.equal(received.length, 2);
      switchMode("unauthorized");
      await assert.rejects(review, /鉴权/);
      assert.equal(received.length, 1);
    });
    await t.test("取消可中断重试等待和正在进行的请求", async () => {
      switchMode("network");
      const controller = new AbortController();
      const reason = new Error("用户取消本次任务");
      await assert.rejects(reviewGeneratedComments(["评论"], "正文", [], controller.signal, (message) => {
        if (message.includes("自动重试")) controller.abort(reason);
      }), (error) => error === reason);
      assert.equal(received.length, 1);
      switchMode("hang");
      const pendingController = new AbortController();
      onRequest = () => pendingController.abort(reason);
      await assert.rejects(reviewGeneratedComments(["评论"], "正文", [], pendingController.signal), (error) => error === reason);
      assert.equal(received.length, 1);
      switchMode("recover");
      await assert.rejects(reviewGeneratedComments([], "正文", [], controller.signal), (error) => error === reason);
      await assert.rejects(generateCommentBatch([], 2, controller.signal), (error) => error === reason);
      await assert.rejects(generateEngagement({ sourceType: "text", text: "正文", targetPlatform: "douyin", includeComments: true, commentCount: 2, includeDanmaku: false, danmakuCount: 0 }, { signal: controller.signal }), (error) => error === reason);
      assert.equal(received.length, 0);
    });
    assert.ok(progress.some((message) => message.includes("自动纠正")));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
