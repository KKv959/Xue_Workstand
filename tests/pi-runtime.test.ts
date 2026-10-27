import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chatCompleteStrict, streamResponseTextWithFallback, readDocumentImages } from "../src/lib/ai";
import { getPiStatus } from "../src/lib/pi-runtime";
import { aiPolicySignature } from "../src/lib/ai-policy-runtime";
import { cleanTranscriptText } from "../src/lib/transcript-cleaning";
import { GET as getPiSettings, PUT as putPiSettings } from "../src/app/api/pi-settings/route";
import { POST as loginPi } from "../src/app/api/pi-settings/login/route";
import { GET as getAiSettings, PUT as putAiSettings } from "../src/app/api/ai-settings/route";

test("Pi 终端默认配置、额度兜底、部分输出与取消隔离", async () => {
  const original = { ...process.env };
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-runtime-test-"));
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  let mode = "ok";
  let fallbackCalls = 0;
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ url: req.url || "", body, auth: req.headers.authorization || "" });
    if (req.url?.startsWith("/legacy")) {
      fallbackCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "中转站完整结果" } }] }));
      return;
    }
    if (mode === "quota" || mode === "auth") {
      res.writeHead(mode === "quota" ? 429 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: mode === "quota" ? "usage_limit_exceeded" : "invalid token fixture-secret" } }));
      return;
    }
    if (mode === "overload") {
      mode = "ok";
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Our servers are currently overloaded" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (req.url === "/pi/responses") {
      res.write(event({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant", content: [] } }));
      res.write(event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Responses 完整结果" }));
      res.end(event({ type: "response.completed", response: { id: "fixture", status: "completed", output: [] } }));
      return;
    }
    const text = mode === "vision" ? '["图中文字"]' : mode === "partial" || mode === "cancel" ? "半篇" : "Pi 完整结果";
    res.write(event({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
    if (mode === "cancel") return;
    if (mode !== "partial") res.write(event({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|PI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { PI_ENABLED: "1", PI_CODING_AGENT_DIR: path.join(root, "pi"), STYLE_LIBRARY_DIR: path.join(root, "library"),
    CHAT_API_KEY: "legacy-key", CHAT_BASE_URL: `${base}/legacy`, CHAT_MODEL: "legacy-model", CHAT_WIRE_API: "chat_completions", CHAT_FALLBACK_ENABLED: "0" });
  await mkdir(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  const settings = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
  const models = path.join(process.env.PI_CODING_AGENT_DIR!, "models.json");
  const writeSettings = (thinking = "low") => writeFile(settings, JSON.stringify({ defaultProvider: "fixture", defaultModel: "pi-model", defaultThinkingLevel: thinking }));
  await writeSettings();
  const writeModels = (api = "openai-completions") => writeFile(models, JSON.stringify({ providers: {
    fixture: { api, baseUrl: `${base}/pi`, apiKey: "pi-key", models: [{ id: "pi-model", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 8192 }] }
  } }));
  await writeModels();
  const messages = [{ role: "system" as const, content: "保留系统指令" }, { role: "user" as const, content: "测试" }];
  try {
    const pageSettings = await getPiSettings();
    assert.equal(pageSettings.status, 200);
    assert.equal(((await pageSettings.json()) as { model: string }).model, "pi-model");
    const blocked = await putPiSettings(new Request("http://localhost/api/pi-settings", { method: "PUT", body: JSON.stringify({ provider: "openai", model: "gpt-5", thinking: "medium" }) }));
    assert.equal(blocked.status, 403, "订阅配置写入需要本机同源页面");
    const wrongOrigin = await putPiSettings(new Request("http://127.0.0.1/api/pi-settings", {
      method: "PUT", headers: { host: "localhost", origin: "http://other.example", "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-5", thinking: "medium" })
    }));
    assert.equal(wrongOrigin.status, 403);
    await writeFile(path.join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), JSON.stringify({ openai: {
      type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000
    } }));
    const saved = await putPiSettings(new Request("http://localhost/api/pi-settings", {
      method: "PUT", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-5", thinking: "medium" })
    }));
    assert.equal(saved.status, 200);
    assert.equal(((await getPiSettings().then(response => response.json())) as { model: string }).model, "gpt-5");
    assert.equal((await getPiStatus()).model, "gpt-5");
    await writeSettings();
    const status = await getPiStatus();
    assert.equal(status.model, "pi-model");
    assert.equal(JSON.stringify(status).includes("pi-key"), false);
    const result = await chatCompleteStrict(messages, "high", { policy: "comment_generate" });
    assert.equal(result.text, "Pi 完整结果"); assert.equal(result.backend, "pi"); assert.equal(result.fallback, false);
    assert.equal(calls[0].auth, "Bearer pi-key"); assert.equal(calls[0].body.model, "pi-model");
    assert.equal(calls[0].body.reasoning_effort, "low", "Pi 默认设置优先于旧业务的模型与推理档位");
    assert.equal(calls[0].body.tools, undefined); assert.equal(fallbackCalls, 0);
    mode = "overload";
    const retried = await chatCompleteStrict(messages, "high", { policy: "comment_generate" });
    assert.equal(retried.fallback, false);
    assert.equal(retried.text, "Pi 完整结果");
    assert.equal(fallbackCalls, 0, "上游临时故障先重试订阅，不立即使用中转");
    const oldSignature = await aiPolicySignature(["comment_generate"]);
    await writeSettings("high");
    assert.notEqual(await aiPolicySignature(["comment_generate"]), oldSignature);
    await chatCompleteStrict(messages);
    assert.equal(calls.at(-1)!.body.reasoning_effort, "high");
    delete process.env.CHAT_API_KEY;
    const cleaned = await cleanTranscriptText({ platform: "bilibili", text: "原稿", useModel: true });
    assert.equal(cleaned.usedModel, "pi-model", "仅配置 Pi 时也可执行转写模型清洗");
    process.env.CHAT_API_KEY = "legacy-key";
    const completionsSignature = (await getPiStatus()).configSignature;
    await writeModels("openai-responses");
    assert.notEqual((await getPiStatus()).configSignature, completionsSignature);
    let responsesText = "";
    const responses = await streamResponseTextWithFallback({ messages, onDelta: delta => { responsesText += delta; } });
    assert.equal(responses.backend, "pi"); assert.equal(responsesText, "Responses 完整结果");
    assert.equal(calls.at(-1)!.body.tools, undefined);
    await writeModels();
    process.env.PI_ENABLED = "1";
    mode = "vision";
    assert.deepEqual(await readDocumentImages(["data:image/png;base64,YQ=="]), ["图中文字"]);
    assert.match(JSON.stringify(calls.at(-1)!.body.messages), /data:image\/png;base64,YQ==/);
    for (mode of ["quota", "auth"]) {
      const before = calls.length;
      const backup = await chatCompleteStrict(messages);
      assert.equal(backup.text, "中转站完整结果"); assert.equal(backup.backend, "legacy"); assert.equal(backup.ok, true); assert.equal(backup.fallback, true);
      assert.match(backup.fallbackReason || "", /原中转站兜底/);
      assert.equal(backup.fallbackReason?.includes("fixture-secret"), false);
      assert.equal(calls.length - before, 2, "Pi 不重试耗尽的额度，直接走旧中转站");
      assert.equal(calls.at(-1)!.auth, "Bearer legacy-key", "订阅凭证不得传给中转站");
    }
    const initialAiSettings = await getAiSettings().then(response => response.json()) as { revision: number; overrides: Record<string, unknown> };
    assert.equal(initialAiSettings.revision, 0, "旧设置缺失来源字段时仍可读取");
    const savePolicy = (revision: number, source: string, origin = "http://localhost") => putAiSettings(new Request("http://localhost/api/ai-settings", {
      method: "PUT", headers: { host: "localhost", origin, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, revision, updatedAt: null,
        overrides: { comment_generate: { model: "", effort: "low", source } } })
    }));
    assert.equal((await savePolicy(0, "relay", "https://work.xjxwork.online")).status, 403, "模型配置写入需要本机同源页面");
    assert.equal((await savePolicy(0, "relay")).status, 200);
    const beforeRelay = calls.length;
    mode = "ok";
    assert.equal((await chatCompleteStrict(messages, "low", { policy: "comment_generate" })).text, "中转站完整结果");
    assert.equal(calls.length - beforeRelay, 1, "仅中转不触发 Pi");
    assert.equal((await savePolicy(0, "subscription")).status, 409, "过期 revision 不覆盖设置");
    assert.equal((await savePolicy(1, "subscription")).status, 200);
    mode = "quota";
    const beforeSubscription = fallbackCalls;
    await assert.rejects(chatCompleteStrict(messages, "low", { policy: "comment_generate" }));
    assert.equal(fallbackCalls, beforeSubscription, "仅订阅失败不兜底");
    assert.equal((await savePolicy(2, "auto")).status, 200);
    assert.equal((await chatCompleteStrict(messages, "low", { policy: "comment_generate" })).backend, "legacy");
    mode = "ok";
    const previousFallbacks = fallbackCalls;
    mode = "partial";
    let partial = "";
    const interrupted = await streamResponseTextWithFallback({ messages, policy: "writer_generate", onDelta: text => { partial += text; } });
    assert.equal(interrupted.ok, false); assert.equal(partial, "半篇"); assert.equal(fallbackCalls, previousFallbacks);
    mode = "cancel";
    const controller = new AbortController();
    await assert.rejects(streamResponseTextWithFallback({ messages, signal: controller.signal, policy: "writer_generate", onDelta() { controller.abort(); } }), { name: "AbortError" });
    assert.equal(fallbackCalls, previousFallbacks);
    mode = "ok";
    await writeFile(settings, "{broken");
    assert.match((await getPiStatus()).message, /损坏/);
    const corrupt = await chatCompleteStrict(messages);
    assert.match(corrupt.fallbackReason || "", /损坏/);
    assert.equal(corrupt.backend, "legacy");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex 订阅登录在网页中直接进入浏览器授权", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-login-test-"));
  const controller = new AbortController();
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const response = await loginPi(new Request("http://localhost/api/pi-settings/login", {
      method: "POST", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex" }), signal: controller.signal
    }));
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const event = JSON.parse(new TextDecoder().decode(value).trim()) as { type: string; data?: { verificationUri: string } };
    assert.equal(event.type, "result");
    assert.match(event.data?.verificationUri || "", /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    await reader.cancel();
  } finally {
    controller.abort();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
