import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareWriteCopyBatchContext, prepareWriteCopyContext } from "../src/lib/ai";
import { saveStyle, upsertAccount } from "../src/lib/storage";
import { writerResearchForWriting } from "../src/lib/writer-research";

test("快速检索：多对象一次搜索、并发合并、保留覆盖、失败不缓存、不交付半截资料", async () => {
  const original = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "writer-fast-research-"));
  const subjects = Array.from({ length: 7 }, (_, i) => `型号${i + 1}`);
  const requests: Record<string, unknown>[] = [];
  let scenario = "success";
  let controller = new AbortController();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    assert.deepEqual(payload.tools, [{ type: "web_search" }], "不再调用独立规划模型");
    if (scenario === "invalid") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid upstream request" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (scenario !== "no-tool") res.write('data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed"}}\n\n');
    if (scenario === "cancel") { controller.abort(); return; }
    const delta = scenario === "empty" ? "   " : subjects.map(subject =>
      `- ${subject} 屏幕规格 1080p，2026 版。来源：https://example.com/${encodeURIComponent(subject)}`
    ).join("\n");
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
    if (scenario !== "incomplete") res.write('data: {"type":"response.completed","response":{}}\n\n');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|WEB_RESEARCH_|OPENCLI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, WEB_RESEARCH_ENABLED: "1", WEB_RESEARCH_API_KEY: "fixture",
    WEB_RESEARCH_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, WEB_RESEARCH_MODEL: "fixture",
    WEB_RESEARCH_REASONING_EFFORT: "low" });
  try {
    const account = await upsertAccount({ platform: "douyin", uid: "fast", name: "快速检索验证" });
    await saveStyle(account.platform, account.id, "自然说明产品。");
    const input = { platform: account.platform, accountId: account.id, mode: "rewrite" as const,
      prompt: "比较全部型号，核实屏幕规格、蒸汽档位和安装条件。", sourceText: subjects.join("、"), useWebResearch: true };
    const progress: string[] = [];
    const [prepared, duplicate] = await Promise.all([
      prepareWriteCopyBatchContext(input, { onProgress: message => progress.push(message) }), prepareWriteCopyContext(input)
    ]);
    assert.equal(requests.length, 1, "七个对象和同时提交的相同任务共用一次搜索");
    assert.equal(prepared.research, duplicate.research);
    for (const subject of subjects) {
      assert.ok(prepared.research?.includes(subject), "保留各对象事实");
      assert.ok((requests[0].input as { content: string }[])[0].content.includes(subject), "不为提速丢弃对象");
    }
    for (const subject of subjects) assert.ok(prepared.variants[0].prepared.messages[1].content.includes(`${subject} 屏幕规格 1080p`));
    assert.ok(progress.some(message => /最长 60 秒/.test(message)));
    assert.equal("max_tool_calls" in requests[0], false, "兼容拒绝 max_tool_calls 的中转节点");
    assert.equal(requests[0].max_output_tokens, 5000);
    assert.deepEqual(requests[0].reasoning, { effort: "low" });
    await prepareWriteCopyContext(input);
    assert.equal(requests.length, 1);
    const cacheDir = path.join(root, ".cache", "writer-research");
    const beforeCache = (await fs.readdir(cacheDir)).length;
    for (scenario of ["invalid", "no-tool", "empty", "incomplete", "cancel"]) {
      const before: number = requests.length;
      controller = new AbortController();
      await assert.rejects(prepareWriteCopyContext({ ...input, prompt: `测试${scenario}` }, { signal: controller.signal }));
      assert.equal((await fs.readdir(cacheDir)).length, beforeCache, "失败、断流和取消均不缓存");
      assert.equal(requests.length - before, scenario === "incomplete" ? 2 : 1, "仅瞬时故障重试一次");
      if (scenario === "incomplete") {
        assert.equal("max_tool_calls" in requests.at(-1)!, false, "非流式重试也不发送不兼容参数");
        assert.equal(requests.at(-1)?.max_output_tokens, 5000);
      }
    }
    const cacheFile = (await fs.readdir(cacheDir))[0];
    await fs.writeFile(path.join(cacheDir, cacheFile), '{"schemaVersion":99}');
    scenario = "success";
    const beforeCorrupt = requests.length;
    await assert.rejects(prepareWriteCopyContext(input), /联网检索缓存损坏/);
    assert.equal(requests.length, beforeCorrupt, "损坏缓存不悄悄重搜覆盖");
    assert.equal(await fs.readFile(path.join(cacheDir, cacheFile), "utf8"), '{"schemaVersion":99}');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("旧稿检索记录兼容：只去除历史记录块，保留自然资料与真实原话", () => {
  const text = "嘉宾说：我不确定周日是否参加。来源：https://example.com/a";
  const record = `${text}\n\n【检索记录，仅供查阅】\n未确认报名人数\n【检索记录结束】`;
  assert.equal(writerResearchForWriting(record), text);
  assert.equal(writerResearchForWriting(text), text);
  assert.equal(writerResearchForWriting("旧资料：嘉宾说不确定。"), "旧资料：嘉宾说不确定。");
  assert.equal(writerResearchForWriting("【检索记录，仅供查阅】没有相关资料【检索记录结束】"), "");
});
