import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { readAiSettings, saveAiSettings, validateAiSettings } from "../src/lib/storage/ai-settings";
import { applyAiPolicy, aiPolicySignature, getAiSettingsView } from "../src/lib/ai-policy-runtime";
import { chatCompleteStrict, streamResponseText, analyzeMaterialFrames } from "../src/lib/ai";
import { getChatConfig } from "../src/lib/model-runtime";
import { assistWriterPrompt } from "../src/lib/writer-prompt-assist";

async function isolated(run: (root: string) => Promise<void>) {
  const env = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "ai-settings-test-"));
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|WEB_RESEARCH_|IMAGE_|FHL_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, CHAT_MODEL: "gpt-6-astra", CHAT_REASONING_EFFORT: "low", CHAT_FALLBACK_ENABLED: "0" });
  try { await run(root); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
}

test("配置原子保存、热读取与并发版本冲突，恢复默认不改其他链路", () => isolated(async (root) => {
  const initial = await readAiSettings();
  const signature = await aiPolicySignature(["comment_plan"]);
  const results = await Promise.allSettled([
    saveAiSettings({ ...initial, overrides: { comment_plan: { model: "gpt-6-astra", effort: "high" } } }),
    saveAiSettings({ ...initial, overrides: { comment_plan: { model: "gpt-5.5", effort: "medium" } } })
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert.ok(failed?.status === "rejected" && failed.reason.status === 409);
  const saved = await readAiSettings();
  assert.equal(saved.revision, 1);
  assert.notEqual(await aiPolicySignature(["comment_plan"]), signature);
  const [config] = await applyAiPolicy([getChatConfig()], "comment_plan");
  assert.equal(config.model, saved.overrides.comment_plan?.model);
  assert.equal(config.reasoningEffort, saved.overrides.comment_plan?.effort);
  const view = await getAiSettingsView();
  assert.ok(view.models.includes("gpt-5.6-sol"));
  assert.equal(view.effective.trendradar.model, "gpt-5.6-sol");
  assert.equal(view.effective.comment_generate.model, "gpt-6-astra");
  assert.equal(view.effective.comment_generate.effort, "low");
  assert.equal(view.effective.danmaku.model, "gpt-6.1-sol");
  assert.equal(view.effective.danmaku.effort, "low");
  assert.deepEqual(view.effective.writer_prompt, { model: "gpt-6.1-sol", effort: "low" });
  assert.equal(view.inheritedEfforts.transcript_clean, "low");
  assert.equal(view.inheritedEfforts.image_generate, "none");
  assert.equal(JSON.stringify(view).includes("apiKey"), false);
  await saveAiSettings({ ...saved, overrides: {} });
  assert.equal(await aiPolicySignature(["comment_plan"]), signature);
  assert.equal(JSON.parse(await readFile(path.join(root, "settings/ai-models.json"), "utf8")).schemaVersion, 1);
}));

test("写作要求润色断线后重试一次，持续失败显式报错，鉴权失败和取消不重试", () => isolated(async () => {
  let calls = 0;
  let mode = "recover";
  let controller: AbortController | undefined;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    if (mode === "reset" || mode === "cancel" || (mode === "recover" && calls === 1)) {
      req.socket.destroy();
      if (mode === "cancel") controller!.abort();
      return;
    }
    res.writeHead(mode === "auth" ? 401 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mode === "auth" ? { error: { message: "unauthorized" } }
      : { choices: [{ message: { content: "语言简短，突出反应切片，按账号风格卡输出。" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  Object.assign(process.env, { CHAT_API_KEY: "synthetic-test-key", CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_WIRE_API: "chat_completions" });
  const run = (signal = new AbortController().signal) => assistWriterPrompt("少讲解，多放反应切片，按账号风格卡来", signal);
  try {
    assert.equal((await run()).text, "语言简短，突出反应切片，按账号风格卡输出。");
    assert.equal(calls, 2);
    mode = "reset"; calls = 0;
    await assert.rejects(run(), /对话模型服务连接异常/);
    assert.equal(calls, 2, "重试耗尽后保留真实失败，不追加请求");
    mode = "auth"; calls = 0;
    await assert.rejects(run(), /鉴权异常/);
    assert.equal(calls, 1);
    mode = "cancel"; calls = 0;
    controller = new AbortController();
    await assert.rejects(run(controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}));

test("损坏配置和未知字段显式失败，不静默回退", () => isolated(async (root) => {
  const value = await readAiSettings();
  assert.throws(() => validateAiSettings({ ...value, overrides: { unknown: { model: "x", effort: "low" } } }), /未知链路/);
  assert.throws(() => validateAiSettings({ ...value, overrides: { image_generate: { model: "gpt-image-2", effort: "high" } } }), /图片模型/);
  assert.throws(() => validateAiSettings({ ...value, overrides: { comment_plan: { model: "bad name", effort: "low" } } }), /模型名称/);
  await mkdir(path.join(root, "settings"), { recursive: true });
  await writeFile(path.join(root, "settings/ai-models.json"), "{broken");
  await assert.rejects(readAiSettings(), /JSON 文件损坏/);
}));

test("真实请求体使用保存的模型及等级，覆盖旧调用参数并支持流式和视觉", () => isolated(async () => {
  const bodies: Record<string, unknown>[] = [];
  let reply: string | undefined;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"测试完成"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: reply ?? JSON.stringify({ visualNotes: "画面", structureNotes: "镜头", titleNotes: "标题" }) } }] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  Object.assign(process.env, { CHAT_API_KEY: "synthetic-test-key", CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_WIRE_API: "chat_completions" });
  try {
    await saveAiSettings({ ...await readAiSettings(), overrides: {
      comment_plan: { model: "gpt-5.5", effort: "high" },
      writer_generate: { model: "gpt-5.5", effort: "low" },
      vision: { model: "gpt-5.5", effort: "medium" }
    } });
    await chatCompleteStrict([{ role: "user", content: "测试" }], "medium", { model: "old-model", policy: "comment_plan" });
    assert.equal(bodies[0].model, "gpt-5.5"); assert.equal(bodies[0].reasoning_effort, "high");
    await streamResponseText({ policy: "writer_generate", reasoningEffort: "high", messages: [{ role: "user", content: "测试" }], onDelta() {} });
    assert.equal(bodies[1].model, "gpt-5.5"); assert.equal(bodies[1].reasoning_effort, "low");
    await analyzeMaterialFrames({ frames: [], platform: "douyin", transcript: "测试", url: "" });
    assert.equal(bodies[2].model, "gpt-5.5"); assert.equal(bodies[2].reasoning_effort, "medium");
    await saveAiSettings({ ...await readAiSettings(), overrides: { comment_plan: { model: "gpt-6-astra", effort: "low" } } });
    await chatCompleteStrict([{ role: "user", content: "测试" }], "high", { policy: "comment_plan" });
    assert.equal(bodies[3].model, "gpt-6-astra"); assert.equal(bodies[3].reasoning_effort, "low");
    const prompt = "最好角度是从‘白酒vs白人’或是‘中国白酒价格震惊老外’或是‘中国白酒在国外算是顶奢’这种角度去切入，然后中间会穿插老哥得知后的切片+老哥喝完酒反应的切片，所以语言描述不用太多，主要还是要有噱头，够标题党，层层爆点，另外按账号风格卡进行输出，要有账号的风格";
    reply = "  可从‘白酒vs白人’‘中国白酒价格震惊老外’或‘中国白酒在国外算是顶奢’等角度切入。中间穿插老哥得知后的切片和喝完酒后的反应切片。语言简短，有噱头、够标题党，爆点层层递进，并按账号风格卡输出。  ";
    assert.deepEqual(await assistWriterPrompt(prompt, new AbortController().signal), { text: reply.trim() });
    assert.equal(bodies[4].model, "gpt-6.1-sol"); assert.equal(bodies[4].reasoning_effort, "low");
    const messages = bodies[4].messages as { role: string; content: string }[];
    assert.deepEqual(messages.at(-1), { role: "user", content: prompt });
    const saved = await readAiSettings();
    await saveAiSettings({ ...saved, overrides: { ...saved.overrides, writer_prompt: { model: "gpt-5.6-sol", effort: "high" } } });
    await assistWriterPrompt("润色这段写作要求", new AbortController().signal);
    assert.equal(bodies[5].model, "gpt-5.6-sol"); assert.equal(bodies[5].reasoning_effort, "high");
    assert.equal((await getAiSettingsView()).effective.writer_prompt.model, "gpt-5.6-sol");
    assert.equal((await getAiSettingsView()).effective.comment_plan.model, "gpt-6-astra");
    for (reply of [" ", "长".repeat(12001)]) {
      await assert.rejects(assistWriterPrompt(prompt, new AbortController().signal), /原要求已保留/);
    }
    reply = "热点分析完成";
    const current = await readAiSettings();
    await saveAiSettings({ ...current, overrides: { ...current.overrides, trendradar: { source: "relay", model: "gpt-5.6-sol", effort: "high" } } });
    await chatCompleteStrict([{ role: "user", content: "分析热点" }], undefined, { policy: "trendradar" });
    assert.equal(bodies.at(-1)?.model, "gpt-5.6-sol");
    assert.equal(bodies.at(-1)?.reasoning_effort, "high");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}));
