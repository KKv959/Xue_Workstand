import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function runExport(platform: string, clipboardFails = false) {
  const source = readFileSync("src/app/gross-margin/_hooks/useGrossMarginWorkbench.ts", "utf8");
  const handler = source.match(/  async function handleExportReview\(\) \{[\s\S]*?\n  \}/)![0];
  const saves: unknown[] = [];
  const notices: Array<{ tone: string; message: string; action?: unknown }> = [];
  const states: string[] = [];
  let copies = 0;
  const run = vm.runInNewContext(ts.transpileModule(`${handler}\nhandleExportReview`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    busy: "", validationError: "", videoUrl: "https://example.test/video", renderedReviewTemplate: {},
    reviewTemplate: { content: "模板" }, reviewTemplateValues: {}, platform,
    calculation: { lines: [{ service: "play", quantity: 1 }] }, matchedAccount: null, accountName: "测试账号", selectedProject: { id: "selected-product-order", projectName: "所选项目" },
    renderGrossMarginReviewTemplate: () => "导出文案", toAbsoluteMetricValue: () => 10000,
    copyText: async () => { copies++; if (clipboardFails) throw new Error("禁止复制"); },
    saveGrossMarginMonitorRecord: async (input: unknown) => { saves.push(input); return { library: {} }; },
    setBusy: (value: string) => states.push(value), setLibrary() {}, setTemplateModalOpen() {},
    notify: (notice: typeof notices[number]) => notices.push(notice), Error, Object
  });
  await run();
  return { saves, notices, states, copies };
}

test("抖音导出仅复制文案，不写入监控记录", async () => {
  const result = await runExport("douyin");
  assert.equal(result.copies, 1);
  assert.equal(result.saves.length, 0);
  assert.equal(result.notices[0].message, "文案已复制");
  assert.equal(result.states.at(-1), "");
});

test("抖音复制被拒绝时提供手动复制入口，仍不写入监控", async () => {
  const result = await runExport("douyin", true);
  assert.equal(result.saves.length, 0);
  assert.equal(result.notices[0].tone, "warning");
  assert.ok(result.notices[0].action);
  assert.equal(result.states.at(-1), "");
});

test("B站导出继续保存监控，复制失败时仍保留监控目标", async () => {
  for (const denied of [false, true]) {
    const result = await runExport("bilibili", denied);
    assert.equal(result.saves.length, 1);
    assert.equal((result.saves[0] as { projectOrderId: string }).projectOrderId, "selected-product-order");
    assert.equal(result.notices[0].tone, denied ? "warning" : "success");
  }
});

