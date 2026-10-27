import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runTrendRadarNative, getTrendRadarNativeStatus, getTrendRadarNativeHtml } from "../src/lib/trendradar-native";
import { trendRadarSettingsSchema } from "../src/lib/trendradar-native-types";
import { startJobSchema } from "../src/lib/job-validation";

test("原生报告任务校验：三种模式及旧任务互斥", () => {
  for (const mode of ["daily", "current", "incremental"]) {
    assert.ok(startJobSchema.safeParse({ kind: "hotspot-refresh", input: { native: { mode } } }).success);
  }
  assert.equal(startJobSchema.safeParse({ kind: "hotspot-refresh", input: { native: {}, continueAnalysis: true } }).success, false);
  assert.equal(trendRadarSettingsSchema.safeParse({ interests: "" }).success, false);
});

test("原生报告初始空状态与中止不写入资料库", async () => {
  const prior = process.env.STYLE_LIBRARY_DIR;
  const root = await mkdtemp(path.join(tmpdir(), "trendradar-native-empty-"));
  process.env.STYLE_LIBRARY_DIR = root;
  try {
    assert.equal((await getTrendRadarNativeStatus()).report, null);
    await assert.rejects(getTrendRadarNativeHtml(), /尚无 TrendRadar 报告/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runTrendRadarNative(trendRadarSettingsSchema.parse({}), { signal: controller.signal }), /已取消/);
    assert.equal((await getTrendRadarNativeStatus()).report, null);
  } finally {
    if (prior === undefined) delete process.env.STYLE_LIBRARY_DIR; else process.env.STYLE_LIBRARY_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker 运行中取消会结束原生采集，不发布报告", { skip: process.env.RUN_TRENDRADAR_INTEGRATION !== "1", timeout: 30000 }, async () => {
  const prior = process.env.STYLE_LIBRARY_DIR;
  const root = await mkdtemp(path.join(tmpdir(), "trendradar-native-cancel-"));
  process.env.STYLE_LIBRARY_DIR = root;
  const controller = new AbortController();
  try {
    await assert.rejects(runTrendRadarNative(trendRadarSettingsSchema.parse({}), {
      signal: controller.signal, onProgress: async () => { controller.abort(); },
    }), /已取消/);
    assert.equal((await getTrendRadarNativeStatus()).report, null);
  } finally {
    if (prior === undefined) delete process.env.STYLE_LIBRARY_DIR; else process.env.STYLE_LIBRARY_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});

// Explicit opt-in integration: real installed engine and configured public
// sources, isolated library and stub model (no developer AI credentials).
test("Docker 原生引擎：真实采集、AI筛选、五板块HTML、持久化及模型失败不覆盖", { skip: process.env.RUN_TRENDRADAR_INTEGRATION !== "1", timeout: 600000 }, async () => {
  const env = { ...process.env };
  const root = await mkdtemp(path.join(tmpdir(), "trendradar-native-integration-"));
  let fail = false;
  const stages = new Set<string>();
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const system = request.messages[0].content as string;
    const user = request.messages.at(-1).content as string;
    if (fail) { res.writeHead(401); res.end("test unauthorized"); return; }
    let value: unknown;
    if (system.includes("专业翻译助手")) { stages.add("translate"); value = [...user.matchAll(/^\[(\d+)\]/gm)].map(match => `[${match[1]}] 测试中文标题 ${match[1]}`).join("\n"); }
    else if (system.includes("兴趣标签提取")) { stages.add("tags"); value = { tags: [{ tag: "游戏", description: "游戏行业与玩家资讯" }] }; }
    else if (system.includes("新闻分类专家")) {
      stages.add("filter");
      const tag = Number(user.match(/## 分类标签\s+(\d+)\./)?.[1] || 1);
      value = [...user.matchAll(/^(\d+)\. \[/gm)].slice(0, 8).map(match => ({ id: Number(match[1]), tag_id: tag, score: 0.95 }));
    } else {
      stages.add("analysis");
      value = { core_trends: "测试核心热点", sentiment_controversy: "测试舆论风向", signals: "测试弱信号", rss_insights: "测试 RSS 洞察", outlook_strategy: "测试策略建议", standalone_summaries: {} };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_|PI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, PI_ENABLED: "0", CHAT_API_KEY: "test", CHAT_MODEL: "test", CHAT_BASE_URL: `http://127.0.0.1:${address.port}/v1`, CHAT_WIRE_API: "chat_completions" });
  try {
    const report = await runTrendRadarNative(trendRadarSettingsSchema.parse({}), { onProgress: async progress => { console.log(progress.message); } });
    assert.equal(report.engineVersion, "6.10.0");
    assert.ok(report.counts.analyzed > 0);
    assert.equal(report.analysis.core_trends, "测试核心热点");
    assert.ok(stages.has("filter") && stages.has("analysis"));
    assert.match(await getTrendRadarNativeHtml(), /测试核心热点/);
    assert.deepEqual((await getTrendRadarNativeStatus()).report, report);
    const file = path.join(root, "hotspots/trendradar-native.json");
    if (process.env.TRENDRADAR_TEST_ARTIFACT) {
      await writeFile(process.env.TRENDRADAR_TEST_ARTIFACT, await readFile(file));
    }
    for (const mode of ["current", "incremental"] as const) {
      const next = await runTrendRadarNative(trendRadarSettingsSchema.parse({ mode }));
      assert.equal(next.settings.mode, mode);
      assert.ok((await getTrendRadarNativeHtml()).includes("TrendRadar"));
    }
    const before = await readFile(file, "utf8");
    fail = true;
    await assert.rejects(runTrendRadarNative(trendRadarSettingsSchema.parse({ interests: "新的关注方向" })), /401|认证|鉴权|密钥|授权/);
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    server.close();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(root, { recursive: true, force: true });
  }
});
