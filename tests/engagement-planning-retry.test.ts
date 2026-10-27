import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planEngagementResearchQueries } from "../src/lib/engagement-research";

test("C 规划支持完整流、网络重试、鉴权失败与取消，两种模型协议一致", async () => {
  const env = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "comment-plan-"));
  let mode = "recover"; let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls += 1;
    if (mode === "auth") { res.writeHead(401); res.end("unauthorized"); return; }
    if ((mode === "recover" && calls === 1) || mode === "cancel") { req.socket.destroy(); return; }
    assert.equal(body.stream, true);
    const content = JSON.stringify({ sources: [{ query: "折叠手机", videoType: "实机体验", discussion: "价格取舍" }], queries: ["折叠手机"], anchors: [], eventTerms: [] });
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: " + JSON.stringify(body.input ? { type: "response.output_text.delta", delta: content } : { choices: [{ delta: { content } }] }) + "\n\n");
    if (mode !== "truncated") res.write(body.input ? 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n' : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  for (const k of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_)/.test(k)) delete process.env[k];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, CHAT_API_KEY: "fixture", CHAT_BASE_URL: "http://127.0.0.1:" + address.port, CHAT_MODEL: "fixture", CHAT_WIRE_API: "chat_completions", CHAT_FALLBACK_ENABLED: "0" });
  const brief = { fullText: "折叠手机的取舍", summary: "", topic: "", subjects: [], keyFacts: [], discussionAngles: [], skepticalAngles: [], anchorTerms: [] };
  try {
    assert.deepEqual((await planEngagementResearchQueries(brief)).queries, ["折叠手机"]); assert.equal(calls, 2);
    for (const wire of ["chat_completions", "responses"]) {
      process.env.CHAT_WIRE_API = wire; mode = "success"; calls = 0;
      await planEngagementResearchQueries(brief); assert.equal(calls, 1);
      mode = "truncated"; calls = 0; await assert.rejects(planEngagementResearchQueries(brief), /失败/); assert.equal(calls, 2);
    }
    mode = "auth"; calls = 0; await assert.rejects(planEngagementResearchQueries(brief), /鉴权/); assert.equal(calls, 1);
    mode = "cancel"; calls = 0; const controller = new AbortController();
    await assert.rejects(planEngagementResearchQueries(brief, controller.signal, (message) => { if (message.includes("自动重试")) controller.abort(new Error("用户取消")); }), /用户取消/); assert.equal(calls, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
