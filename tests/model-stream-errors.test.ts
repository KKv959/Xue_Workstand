import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { streamResponseText, streamResponseTextWithFallback, completePreparedWriteCopy } from "../src/lib/ai";
import { classifyModelFailure, ModelHttpError } from "../src/lib/model-runtime";

test("Pi 额度错误不覆盖最终中转站的渠道错误", () => {
  const transport = new ModelHttpError(503, JSON.stringify({ error: {
    code: "model_not_found", message: "No available channel for model gpt-6-astra under group codex-稳定"
  } }));
  const relay = new Error("中转站请求失败", { cause: transport });
  const combined = new Error("Pi 额度不足或限流；原中转站兜底也失败", { cause: relay });
  for (const error of [transport, combined, Object.assign(new Error("流式失败"), { originalError: combined })]) {
    const failure = classifyModelFailure(error);
    assert.equal(failure.kind, "endpoint");
    assert.match(failure.userMessage, /没有该模型的可用渠道/);
    assert.doesNotMatch(failure.userMessage, /额度不足/);
  }
  const quota = new ModelHttpError(402, '{"error":{"code":"insufficient_quota"}}');
  assert.equal(classifyModelFailure(new Error("备用调用失败", { cause: quota })).kind, "quota");
});

test("本地请求超时及流式包装错误均保留超时分类", () => {
  const error = new Error("对话模型请求超时（超过 120 秒）");
  for (const value of [error, Object.assign(new Error("流式失败"), { originalError: error }), new Error("生成失败", { cause: error })]) {
    assert.equal(classifyModelFailure(value).kind, "timeout");
    assert.match(classifyModelFailure(value).userMessage, /超时/);
  }
});

test("写作仍在生成时允许超过两分钟，不误判半篇为超时", async (t) => {
  const original = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "writer-slow-stream-"));
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"type":"response.output_text.delta","delta":"开头"}\n\n');
    setImmediate(() => {
      t.mock.timers.tick(130_000);
      res.end('data: {"type":"response.output_text.delta","delta":"结尾"}\n\ndata: {"type":"response.completed","response":{}}\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, CHAT_API_KEY: "fixture", CHAT_MODEL: "fixture",
    CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_WIRE_API: "responses", CHAT_FALLBACK_ENABLED: "0" });
  try {
    for (const policy of ["writer_generate", "writer_revise"] as const) {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const result = await streamResponseTextWithFallback({ policy,
        messages: [{ role: "user", content: "测试" }], onDelta() {},
        onRetry(message) { t.mock.timers.reset(); assert.fail(`正常慢请求不应重试：${message}`); } });
      t.mock.timers.reset();
      assert.equal(result.ok, true);
      assert.equal(result.text, "开头结尾");
    }
    assert.equal(calls, 2, "正常慢请求不应重发模型请求");
  } finally {
    t.mock.timers.reset();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("写作流真实超时会重试，已输出半篇时保留超时原因并拒绝保存", async (t) => {
  const original = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "writer-stream-timeout-"));
  let calls = 0;
  let partial = false;
  let wireApi = "chat_completions";
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    if (!partial && calls === 1) {
      // Advance the real request deadline without waiting or calling an external model.
      setImmediate(() => t.mock.timers.tick(300_001));
      return;
    }
    const text = partial ? "半篇" : "完整稿件";
    res.write(wireApi === "responses"
      ? event({ type: "response.output_text.delta", delta: text })
      : event({ choices: [{ delta: { content: text } }] }));
    if (!partial) res.end(wireApi === "responses"
      ? event({ type: "response.completed", response: { status: "completed" } })
      : "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, CHAT_API_KEY: "fixture", CHAT_MODEL: "fixture",
    CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_FALLBACK_ENABLED: "0" });
  try {
    for (wireApi of ["chat_completions", "responses"]) {
      process.env.CHAT_WIRE_API = wireApi;
      calls = 0;
      partial = false;
      const retries: string[] = [];
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const recovered = await streamResponseTextWithFallback({ policy: "writer_generate",
        messages: [{ role: "user", content: "测试" }], onDelta() {},
        onRetry(message) { retries.push(message); t.mock.timers.reset(); } });
      assert.equal(recovered.text, "完整稿件");
      assert.equal(calls, 2);
      assert.equal(retries.length, 1);
      assert.match(retries[0], /超时/);

      calls = 0;
      partial = true;
      let received = "";
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const interrupted = await streamResponseTextWithFallback({ policy: "writer_revise",
        messages: [{ role: "user", content: "测试" }],
        onDelta(text) { received += text; t.mock.timers.tick(300_001); } });
      t.mock.timers.reset();
      assert.equal(received, "半篇");
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.errorKind, "timeout");
      assert.equal(calls, 1, "半篇稿件不得与重试输出拼接");
      await assert.rejects(completePreparedWriteCopy({ prepared: { messages: [], contextFingerprint: "fixture",
        sourceDigest: { materialCount: 0, linkCount: 0, textMaterialCount: 0, onlyLinkCount: 0 } },
        result: interrupted, save: true }), /超时/);
    }
  } finally {
    t.mock.timers.reset();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("写作临时故障只重试一次；参数错误、部分输出和取消不追加请求", async () => {
  const original = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "writer-retry-"));
  let calls = 0;
  let mode = "recover";
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    if (mode === "invalid" || mode === "fail" || mode === "cancel" || (mode === "recover" && calls === 1) || req.url?.startsWith("/primary")) {
      res.writeHead(mode === "invalid" ? 400 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture failure" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(event({ choices: [{ delta: { content: mode === "partial" ? "半篇" : "完整稿件" } }] }) +
      (mode === "partial" ? event({ error: { message: "overloaded" } }) : "data: [DONE]\n\n"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_)/.test(key)) delete process.env[key];
  const baseUrl = `http://127.0.0.1:${address.port}`;
  Object.assign(process.env, {
    STYLE_LIBRARY_DIR: root, CHAT_API_KEY: "fixture", CHAT_BASE_URL: baseUrl,
    CHAT_MODEL: "fixture", CHAT_WIRE_API: "chat_completions", CHAT_FALLBACK_ENABLED: "0"
  });
  const run = (options: { signal?: AbortSignal; onRetry?: (message: string) => void; onDelta?: (text: string) => void } = {}) =>
    streamResponseTextWithFallback({ policy: "writer_generate", messages: [{ role: "user", content: "测试" }], onDelta() {}, ...options });
  try {
    const retries: string[] = [];
    assert.equal((await run({ onRetry: message => { retries.push(message); } })).text, "完整稿件");
    assert.equal(calls, 2);
    assert.equal(retries.length, 1);
    assert.match(retries[0], /重试 1\/1/);
    mode = "fail"; calls = 0;
    await assert.rejects(run(), /模型服务暂时异常/);
    assert.equal(calls, 2, "重试耗尽后不再额外发非流式请求");
    mode = "invalid"; calls = 0;
    await assert.rejects(run(), /参数或模型配置不兼容/);
    assert.equal(calls, 1);
    mode = "partial"; calls = 0;
    let partial = "";
    const result = await run({ onDelta: text => { partial += text; } });
    assert.equal(result.ok, false);
    assert.equal(partial, "半篇");
    assert.equal(calls, 1);
    await assert.rejects(completePreparedWriteCopy({ prepared: { messages: [], contextFingerprint: "fixture",
      sourceDigest: { materialCount: 0, linkCount: 0, textMaterialCount: 0, onlyLinkCount: 0 } }, result }), /过载/);
    mode = "cancel"; calls = 0;
    const controller = new AbortController();
    await assert.rejects(run({ signal: controller.signal, onRetry() { controller.abort(); } }), { name: "AbortError" });
    assert.equal(calls, 1);
    mode = "fallback"; calls = 0;
    Object.assign(process.env, { CHAT_BASE_URL: `${baseUrl}/primary`, CHAT_FALLBACK_ENABLED: "1",
      CHAT_FALLBACK_API_KEY: "fixture-backup", CHAT_FALLBACK_BASE_URL: `${baseUrl}/backup`, CHAT_FALLBACK_WIRE_API: "chat_completions" });
    const backup = await run();
    assert.equal(backup.ok, true);
    assert.equal(backup.fallback, true);
    assert.match(backup.fallbackReason || "", /备用对话模型节点/);
    assert.equal(calls, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP 503 型号不存在归为配置错误，不按暂时故障重试", () => {
  const error = new ModelHttpError(503, JSON.stringify({ error: { code: "model_not_found" } }));
  for (const value of [error, new Error("关键词规划失败", { cause: error })]) {
    const failure = classifyModelFailure(value);
    assert.equal(failure.kind, "endpoint");
    assert.match(failure.userMessage, /当前节点不支持所选模型/);
  }
});

test("HTTP 400/422 参数拒绝不归为可重试的上游故障", () => {
  for (const status of [400, 422]) {
    const failure = classifyModelFailure(new ModelHttpError(status, JSON.stringify({ error: { message: "invalid upstream request" } })));
    assert.equal(failure.kind, "endpoint");
    assert.match(failure.userMessage, /请求参数或模型配置不兼容/);
  }
  const unavailable = new ModelHttpError(503, JSON.stringify({ error: { code: "no_available_provider" } }));
  assert.equal(classifyModelFailure(unavailable).kind, "server");
});

test("HTTP200流内错误明确失败，部分文本不冒充完整成功", async () => {
  const original = { ...process.env };
  let body = "";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    CHAT_API_KEY: "fixture", CHAT_BASE_URL: `http://127.0.0.1:${address.port}`,
    CHAT_MODEL: "gpt-6-astra", CHAT_WIRE_API: "chat_completions", CHAT_FALLBACK_ENABLED: "0"
  });
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const run = (onDelta: (text: string) => void = () => {}) => streamResponseText({
    messages: [{ role: "user", content: "测试" }], reasoningEffort: "low", onDelta
  });
  try {
    body = event({ error: { message: "Our servers are currently overloaded. Please try again later." } });
    await assert.rejects(run(), error => {
      const failure = classifyModelFailure(error);
      assert.equal(failure.kind, "server");
      assert.match(failure.userMessage, /过载/);
      return true;
    });
    body = event({ error: { message: "Rate limit exceeded" } });
    await assert.rejects(run(), /限流/);
    body = event({ error: { message: "private endpoint secret-value" } });
    await assert.rejects(run(), error => error instanceof Error && /流式响应返回错误/.test(error.message) && !error.message.includes("secret-value"));
    body = event({ choices: [{ delta: { content: "未完成" } }] }) + event({ error: { message: "overloaded" } });
    let partial = "";
    await assert.rejects(run(text => { partial += text; }));
    assert.equal(partial, "未完成");
    body = event({ choices: [{ delta: { content: "完成" } }] }) + "data: [DONE]\n\n";
    assert.equal((await run()).text, "完成");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
