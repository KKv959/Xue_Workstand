import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Offline diagnostics: execute actual source functions with in-memory dependencies.
// No production library, credentials, model endpoints or external adapters are loaded.
const root = path.resolve(import.meta.dirname, "..");
const report = { purpose: "明确标注的内部模拟 / 离线诊断", method: "真实函数 + 内存桩；不是模型质量或网络性能测试", checks: [] };

async function isolate(relative, dependencies = {}, overrides = "") {
  const text = await readFile(path.join(root, relative), "utf8");
  const parsed = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const withoutImports = parsed.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(parsed)).join("\n");
  const compiled = ts.transpileModule(withoutImports, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {}, process: { env: {} }, getChatRuntimeConfig: () => ({ configured: false }), ...dependencies });
  vm.runInContext(compiled + "\n" + overrides, context, { timeout: 1000, filename: relative });
  return context;
}

async function check(name, run) {
  const result = await run();
  report.checks.push({ name, ...result });
  console.log(`${result.status === "issue" ? "发现问题" : "通过"}：${name}`);
}

const core = await isolate("src/lib/engagement.ts", {
  clampText: (text, limit) => text.slice(0, limit),
  containsEngagementTransportLeak: () => false
});
const guard = { allowedModels: [], allowedModelKeys: new Set(), blockedModels: [], blockedModelKeys: new Set(), aliases: new Map() };
function brief(title, content) {
  return core.buildLocalCommentSourceBrief({ title, content, id: "simulation" }, guard, {}).brief;
}

await check("三种题材的短句事实进入 Brief", () => {
  const samples = [
    ["数码", "耳机续航为8小时。续航测试未说明是否开启降噪。", "续航测试未说明是否开启降噪"],
    ["游戏", "合作地图支持2至4人组队。公告未说明能否自动匹配队友。", "公告未说明能否自动匹配队友"],
    ["剧情", "主角在门口发现一个信封。信封没有署名，寄件人尚未揭晓。", "信封没有署名，寄件人尚未揭晓"]
  ];
  const observations = samples.map(([topic, text, expected]) => {
    const result = brief(topic, text);
    assert.ok(result.keyFacts.includes(expected));
    return { topic, retained: expected };
  });
  return { status: "pass", observations, limitation: "只验证事实保留，不代表正确识别所有讨论点" };
});

await check("长句中的关键限制是否丢失", () => {
  const sentence = "这里继续补充产品的介绍和使用说明".repeat(12) + "续航测试明确关闭降噪";
  const result = brief("续航测试", sentence + "。支持蓝牙连接。");
  const retained = result.keyFacts.some(text => text.includes("关闭降噪")) || result.discussionAngles.some(text => text.includes("关闭降噪"));
  assert.equal(retained, false);
  return { status: "issue", sentenceChars: sentence.length, retained, reason: "本地 Brief 排除超过120字的句子，关键限制未进入事实及讨论点", boundary: "原始正文仍可能作为节选进入后续提示词，不能据此断言模型一定看不到该信息" };
});

await check("文末关键信息是否进入讨论依据", () => {
  const prefix = Array.from({ length: 15 }, (_, i) => `第${i + 1}段介绍普通包装信息`);
  const result = brief("产品介绍", prefix.join("。") + "。售后不接受拆封退货。");
  const retained = result.keyFacts.some(text => text.includes("拆封退货")) || result.discussionAngles.some(text => text.includes("拆封退货"));
  assert.equal(retained, false);
  return { status: "issue", retained, reason: "前面的带数字句子先占满事实与讨论点的固定名额，结尾限制未进入两者", boundary: "不等于原始正文被删除" };
});

await check("从记录补齐是否恢复真实时间轴", async () => {
  const record = { id: "simulation", sourceType: "url", title: "模拟", sourceText: "模拟内容", platform: "bilibili", sourceUrl: "https://example.invalid/simulation", durationSec: 120, segments: [{ startSec: 80, endSec: 85, text: "信息在80秒才出现" }] };
  const instance = await isolate("src/lib/engagement.ts", { resolveEngagementRecord: async () => record });
  const prepared = await instance.prepareEngagementSource({ sourceType: "record", recordId: record.id }, { includeDanmaku: true });
  assert.equal(prepared.content.segments, undefined);
  assert.equal(prepared.content.durationSec, undefined);
  return { status: "issue", restoredSegments: false, restoredDuration: false, reason: "即使桩记录提供时间轴，记录恢复分支也未传给生成内容；当前实际记录类型本身同样缺少素材时间轴" };
});

await check("补齐合并是否保留任务累计耗时", async () => {
  let clock = 0;
  let record = { id: "simulation", sourceType: "text", title: "模拟", sourceText: "模拟文本", platform: "bilibili", options: { includeComments: true, commentCount: 2, includeDanmaku: false, danmakuCount: 1 }, comments: { requestedCount: 2, items: [{ id: "a", text: "模拟A" }], timings: { totalMs: 1200 } } };
  const instance = await isolate("src/lib/engagement.ts", {
    Date: { now: () => clock },
    resolveEngagementRecord: async () => record,
    updateEngagementRecord: async (_id, update) => { record = update(record); return record; },
    fakeComments: async () => { clock += 50; return {}; }
  }, `
    generateComments = fakeComments;
    buildSavedCommentAsset = (_result, _count, _mode, timings) => ({ items: [{ id: 'b', text: '模拟B' }], timings });
    mergeCommentItems = (a, b) => [...a, ...b];
    mergeSupplementDiagnostics = () => undefined;
  `);
  const result = await instance.generateEngagementPass({ sourceType: "record", recordId: "simulation", includeComments: true, commentCount: 1, includeDanmaku: false });
  assert.equal(result.record.comments.items.length, 2);
  assert.equal(result.record.comments.timings.totalMs, 50);
  return { status: "issue", firstPassMs: 1200, supplementMs: 50, savedMs: 50, expectedCumulativeMs: 1250, reason: "执行真实合并函数后，新 timings 覆盖上一轮；数字为可控虚拟时间，非实际模型耗时" };
});

await check("外层自动补齐是否有界", async () => {
  let calls = 0;
  const record = { id: "simulation", options: { includeComments: true, commentCount: 2, includeDanmaku: false }, comments: { requestedCount: 2, items: [{ id: "one", text: "模拟数据" }] } };
  const instance = await isolate("src/lib/engagement.ts", { fakePass: async () => { calls++; return { record }; } }, "generateEngagementPass = fakePass;");
  await instance.generateEngagement({});
  assert.equal(calls, 3);
  return { status: "pass", passCalls: calls, reason: "初次执行加两次外层补齐后停止；不代表每一轮内部只有一次模型调用" };
});

await check("评论与弹幕冷启动是否共享一次语料扫描", async () => {
  let directoryScans = 0;
  const instance = await isolate("src/lib/engagement-style.ts", {
    libraryRoot: () => "/in-memory-simulation", path,
    scan: async () => { directoryScans++; await Promise.resolve(); }
  }, "collectJsonSamples = scan; collectBenchmarkSamples = async () => {}; ");
  await Promise.all([instance.loadLocalStyleCorpus(), instance.loadLocalStyleCorpus()]);
  assert.equal(directoryScans, 6);
  await instance.loadLocalStyleCorpus();
  assert.equal(directoryScans, 6);
  return { status: "issue", concurrentRootScans: 6, expectedSharedRootScans: 3, warmAdditionalScans: 0, reason: "三处目录的两次冷加载重复执行；完成后的热缓存有效。目录扫描使用内存桩，未测磁盘耗时" };
});

const outputDir = path.join(root, "outputs", "engagement-simulation-test");
await mkdir(outputDir, { recursive: true });
const destination = path.join(outputDir, "diagnostics.json");
const temporary = `${destination}.tmp-${process.pid}`;
await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", "utf8");
await rename(temporary, destination);
console.log(`诊断完成：${report.checks.length}项，发现${report.checks.filter(check => check.status === "issue").length}项问题。报告：${destination}`);
