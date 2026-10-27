import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "pino";
import { buildWriterWebResearchMessages, completePreparedWriteCopy, prepareWriteCopyContext, webSearchCompleteStrict } from "../src/lib/ai";
import { saveStyle, upsertAccount } from "../src/lib/storage";
import { writerResearchBoundaryInstruction } from "../src/lib/writer-prompts";
import { getConfiguredWebResearchConfigs } from "../src/lib/model-runtime";
import { cachedWriterResearch } from "../src/lib/storage/writer-research";
import { readAiSettings, saveAiSettings } from "../src/lib/storage/ai-settings";

test("主题检索保留素材中的对象和时间条件，支持资料与要求分开传递", () => {
  const input = { mode: "topic" as const, prompt: "写一期游戏杂谈", sourceText: "《篮球少女》2026年5月测试的玩家讨论",
    supportDocContext: "官方说明：本次是测试版本" };
  const messages = buildWriterWebResearchMessages(input);
  assert.equal(messages.length, 2);
  for (const content of [input.prompt, input.sourceText, input.supportDocContext]) {
    assert.ok(messages[1].content.includes(content));
  }
  const withoutMaterials = buildWriterWebResearchMessages({ mode: "topic", prompt: "杭州活动" });
  assert.ok(!withoutMaterials[1].content.includes("undefined"));
});

test("原生检索失败直接停止，不兜底或缓存失败；旧备用缓存及不同强度的缓存不复用", async () => {
  const original = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "writer-strict-research-"));
  const requests: Record<string, unknown>[] = [];
  let fail = true;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (fail) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid upstream request" } }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: {"type": "response.output_item.done", "item": {"type": "web_search_call", "status": "completed"}}\n\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "已查到真实资料，来源：https://example.com/source" })}\n\ndata: {"type":"response.completed","response":{}}\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|WEB_RESEARCH_|OPENCLI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, WEB_RESEARCH_ENABLED: "1", WEB_RESEARCH_API_KEY: "fixture",
    WEB_RESEARCH_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, WEB_RESEARCH_MODEL: "fixture",
    OPENCLI_BIN: path.join(root, "unavailable-opencli") });
  try {
    const account = await upsertAccount({ platform: "douyin", name: "严格检索", uid: "strict-research" });
    await saveStyle(account.platform, account.id, "自然口语介绍产品。");
    const input = { platform: account.platform, accountId: account.id, mode: "topic" as const,
      prompt: "介绍某个产品", useWebResearch: true };
    const legacyFingerprint = JSON.stringify({ version: 2, messages: buildWriterWebResearchMessages(input),
      configs: getConfiguredWebResearchConfigs().map(({ baseUrl, responsesUrl, model, wireApi, serviceTier }) => ({ baseUrl, responsesUrl, model, wireApi, serviceTier })) });
    await cachedWriterResearch(legacyFingerprint, async () => ({ content: "检索方式：opencli duckduckgo search\n旧备用搜索资料", cacheable: true }));
    for (let count = 1; count <= 2; count++) {
      await assert.rejects(prepareWriteCopyContext(input), /接口不兼容.*本次未生成草稿/);
      assert.equal(requests.length, count, "失败不缓存，不悄悄返回旧备用资料或发起正文请求");
    }
    assert.equal((await fs.readdir(path.join(root, ".cache", "writer-research"))).length, 1, "只保留已有的旧缓存文件");
    fail = false;
    const prepared = await prepareWriteCopyContext(input);
    assert.match(prepared.research || "", /已查到真实资料/);
    assert.equal(requests.length, 3);
    assert.equal((await prepareWriteCopyContext(input)).research, prepared.research);
    assert.equal(requests.length, 3);
    const settings = await readAiSettings();
    await saveAiSettings({ ...settings, overrides: { web_research: { model: "", effort: "high" } } });
    await prepareWriteCopyContext(input);
    assert.equal(requests.length, 4, "检索强度变化后重新检索");
    assert.deepEqual(requests.at(-1)?.reasoning, { effort: "high" });
    assert.ok(requests.every(request => Array.isArray(request.tools)), "所有模型请求均为联网研究，未启动正文生成");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("写作检索 59 秒可完成；60 秒预算到期明确失败，不重试或生成草稿", async (t) => {
  const original = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "writer-slow-research-"));
  let calls = 0;
  let elapsed = 59_000;
  const logger = (globalThis as typeof globalThis & { __styleWorkbenchLogger?: Logger }).__styleWorkbenchLogger;
  assert.ok(logger);
  const info = t.mock.method(logger, "info");
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal("max_tool_calls" in JSON.parse(body), false);
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed"}}\n\n');
    setImmediate(() => {
      t.mock.timers.tick(elapsed);
      res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "已查到官方介绍，来源：https://example.com/product" })}\n\ndata: {"type":"response.completed","response":{}}\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|WEB_RESEARCH_|OPENCLI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, WEB_RESEARCH_ENABLED: "1", WEB_RESEARCH_API_KEY: "fixture",
    WEB_RESEARCH_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, WEB_RESEARCH_MODEL: "fixture",
    // The regression must never launch the user's browser when the old deadline fires.
    OPENCLI_BIN: path.join(root, "unavailable-opencli") });
  try {
    const account = await upsertAccount({ platform: "douyin", name: "慢检索", uid: "slow-research" });
    await saveStyle(account.platform, account.id, "自然口语介绍产品。");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const prepared = await prepareWriteCopyContext({ platform: account.platform, accountId: account.id,
      mode: "topic", prompt: "介绍微蒸烤一体机", useWebResearch: true });
    assert.match(prepared.research || "", /已查到官方介绍[\s\S]*https:\/\/example.com\/product/);
    assert.equal(calls, 1);
    const diagnostic = info.mock.calls.map(call => call.arguments[0] as Record<string, unknown>)
      .find(event => event.event === "model.web-research-stream");
    assert.equal(diagnostic?.status, "completed");
    assert.equal(diagnostic?.eventCount, 3);
    assert.equal(typeof diagnostic?.firstSearchMs, "number");
    assert.ok(Number(diagnostic?.outputChars) > 0);
    assert.ok(!JSON.stringify(diagnostic).includes("官方介绍"));

    elapsed = 60_001;
    await assert.rejects(prepareWriteCopyContext({ platform: account.platform, accountId: account.id,
      mode: "topic", prompt: "另一个产品的官方介绍", useWebResearch: true }), /模型联网搜索超时，本次未生成草稿/);
    assert.equal(calls, 2, "总预算到期后不再发起一次注定超时的完整重试");
  } finally {
    t.mock.timers.reset();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("首选搜索兼容 auto 工具选择，断流仅重试一次；参数、限流、鉴权和取消不重试", async () => {
  const originalEnv = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "writer-research-recovery-"));
  let scenario = "disconnect";
  const requests: Record<string, unknown>[] = [];
  let controller = new AbortController();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    // Reproduce relays which reject forced built-in tool selection.
    if (payload.tool_choice === "required" || scenario === "invalid" || scenario === "auth") {
      res.writeHead(scenario === "auth" ? 401 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: scenario === "auth" ? "unauthorized" : "invalid upstream request" } }));
      return;
    }
    if (scenario === "rate-limit") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" } } })}\n\n`);
      return;
    }
    if (scenario === "no-tool") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"type":"response.output_text.delta","delta":"仅凭记忆的回答 https://example.com/source"}\n\ndata: {"type":"response.completed","response":{}}\n\n');
      return;
    }
    if (payload.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "不完整资料" })}\n\n`);
      if (scenario === "cancel") controller.abort();
      if (scenario === "disconnect") setTimeout(() => res.destroy(), 20);
      else res.end(); // A clean EOF without response.completed is also incomplete.
      return;
    }
    if (scenario === "retry-eof") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed"}}\n\ndata: {"type":"response.output_text.delta","delta":"半截资料"}\n\n');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "completed", output: [
      { type: "web_search_call", status: "completed" },
      { type: "message", content: [{ type: "output_text", text: "完整资料 https://example.com/source" }] }
    ] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const key of Object.keys(process.env)) {
    if (/^(CHAT_|OPENAI_|FHL_|WEB_RESEARCH_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, WEB_RESEARCH_ENABLED: "1",
    WEB_RESEARCH_API_KEY: "fixture-key", WEB_RESEARCH_MODEL: "fixture",
    WEB_RESEARCH_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    CHAT_FALLBACK_ENABLED: "0" });
  try {
    for (scenario of ["disconnect", "eof", "retry-eof", "invalid", "rate-limit", "auth", "cancel", "no-tool"]) {
      requests.length = 0;
      controller = new AbortController();
      const run = () => webSearchCompleteStrict([{ role: "user", content: "搜索篮球少女" }], "low", { signal: controller.signal });
      if (scenario === "retry-eof") {
        await assert.rejects(run, /联网搜索连接中断/);
        assert.equal(requests.length, 2, "重试仍不完整时明确失败，不继续无限重试");
      } else if (["invalid", "rate-limit", "auth", "cancel", "no-tool"].includes(scenario)) {
        if (scenario === "no-tool") await assert.rejects(run, /模型没有实际调用 web_search 工具/);
        else await assert.rejects(run);
        assert.equal(requests.length, 1);
      } else {
        const result = await run();
        assert.equal(result.text, "完整资料 https://example.com/source");
        assert.deepEqual(result.usedTools, ["web_search"]);
        assert.deepEqual(requests.map(request => request.stream), [true, false]);
        assert.deepEqual(requests[1].tools, [{ type: "web_search" }]);
        for (const request of requests) assert.equal("max_output_tokens" in request, false, "首次和重试均不注入固定输出上限");
      }
      for (const request of requests) assert.equal(request.tool_choice, "auto");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("简短联网资料直接用于首稿与续改，保留来源和用户原话，不追加搜索", async () => {
  const originalEnv = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "writer-research-boundary-"));
  let researchText = "";
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.output_item.done", item: { type: "web_search_call", status: "completed" } },
      { type: "response.output_text.delta", delta: researchText },
      { type: "response.completed", response: {} }
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  for (const key of Object.keys(process.env)) {
    if (/^(CHAT_|OPENAI_|FHL_|WEB_RESEARCH_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    STYLE_LIBRARY_DIR: root,
    WEB_RESEARCH_ENABLED: "1",
    WEB_RESEARCH_API_KEY: "fixture-key",
    WEB_RESEARCH_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    WEB_RESEARCH_MODEL: "fixture",
    CHAT_FALLBACK_ENABLED: "0"
  });
  try {
    const account = await upsertAccount({ platform: "douyin", name: "资料边界测试", uid: "research-boundary" });
    await saveStyle(account.platform, account.id, "用自然口语介绍活动。");
    const source = "主办方宣布活动周六开始。嘉宾说：我还不确定周日是否参加。";
    const input = { platform: account.platform, accountId: account.id, mode: "rewrite" as const,
      prompt: "介绍活动，保留嘉宾原话", sourceText: source, useWebResearch: true };
    for (const material of ["暂无补充资料。", "- 官方宣布周六开始。来源：https://example.com/event"]) {
      researchText = material;
      const count = requests.length;
      const prepared = await prepareWriteCopyContext(input);
      assert.equal(requests.length, count + 1, "准备首稿只请求一次联网研究");
      assert.deepEqual(requests.at(-1)?.tools, [{ type: "web_search" }]);
      assert.equal(requests.at(-1)?.tool_choice, "auto");
      assert.equal(requests.at(-1)?.max_output_tokens, 5000);
      assert.equal("max_tool_calls" in requests.at(-1)!, false);
      assert.ok(prepared.messages[0].content.includes(writerResearchBoundaryInstruction()));
      assert.ok(prepared.messages[1].content.includes(material), "自然文本直接交给写作模型");
      assert.ok(prepared.messages[1].content.includes(source), "素材本身的不确定性不被删词过滤");
      assert.ok(prepared.research?.includes(material), "保留完整资料和来源");
      await saveStyle(account.platform, account.id, "简短开场，再按时间顺序介绍活动。");
      const reused = await prepareWriteCopyContext(input);
      assert.equal(requests.length, count + 1, "重新生成或改变风格卡仍复用联网资料");
      assert.equal(reused.research, prepared.research);
      const result = await completePreparedWriteCopy({ prepared, save: true,
        result: { text: source, model: "fixture", ok: true, fallback: false } });
      assert.equal(result.content, source, "不通过后处理删除合法的“不确定”原话");
      const draft = result.draft!;
      const revised = await prepareWriteCopyContext({ ...input, action: "revise", parentDraftId: draft.id,
        currentContent: draft.content, revisionInstruction: "开头更自然", revisionScope: "selection", selectedText: "主办方宣布活动周六开始。" });
      assert.equal(requests.length, count + 1, "续改复用资料，不重新联网");
      assert.ok(revised.messages[0].content.includes(writerResearchBoundaryInstruction()));
      assert.match(revised.messages[1].content, /其他段落保持不变/);
      assert.equal(revised.research, prepared.research);
      assert.ok(revised.messages[1].content.includes(material));
      assert.ok(revised.messages[1].content.includes(source));
      input.prompt += "。补充核实周日安排";
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
});
