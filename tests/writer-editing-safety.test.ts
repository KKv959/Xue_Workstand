import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildWriterDraftHref } from "../src/lib/draft-links";
import { extractRewriteSourceMaterial } from "../src/lib/source-extraction";
import { isActiveJob, isTerminalJob } from "../src/lib/job-sync";
import type { Draft, JobListItem, JobRecord } from "../src/lib/types";
import type { useWriterGeneration } from "../src/app/writer/_hooks/useWriterGeneration";

type HookInput = Parameters<typeof useWriterGeneration>[0];

// Run the actual hook with deferred API responses; no DOM, storage or model calls.
function writer(saveDraft: (input: object) => Promise<Draft>) {
  const states: unknown[] = [], refs: Array<{ current: unknown }> = [];
  let cursor = 0, refCursor = 0;
  let effects: Array<() => void> = [];
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef(initial: unknown) { const index = refCursor++; return refs[index] ||= { current: initial }; },
    useMemo: (run: () => unknown) => run(),
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void) => effects.push(effect)
  };
  const exports = {} as { useWriterGeneration: typeof useWriterGeneration };
  const dependencies: Record<string, unknown> = {
    react, "@/lib/client": { saveDraft }, "@/lib/draft-links": { buildWriterDraftHref },
    "@/lib/job-scope": { writeCopySourceKey: () => "test" }
  };
  const source = readFileSync(new URL("../src/app/writer/_hooks/useWriterGeneration.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require(name: string) { if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`); return dependencies[name]; } });
  const input: HookInput = {
    activeJobs: [], recentJobs: [], busy: "", hasTaskInput: true, mode: "topic",
    normalizedPrompt: "测试", normalizedSourceText: "", originalSourceInput: "", supportDocLinks: "",
    selectedAccount: null, styleRefs: [{ targetType: "account", platform: "douyin", accountId: "a" }],
    revisionInstruction: "精简", revisionScope: "full", revisionMode: "edit", selectedText: "", useWebResearch: false,
    setBusy(value) { input.busy = typeof value === "function" ? value(input.busy) : value; }, setNotice() {},
    refresh: async () => {}, routerPush() {}, routerReplace() {}, cancelTask: async () => { throw new Error("Unexpected cancellation API"); },
    startTask: async () => { throw new Error("启动失败"); }
  };
  const render = () => { cursor = 0; refCursor = 0; effects = []; return exports.useWriterGeneration(input); };
  return { input, render, syncJob() { for (const effect of effects) effect(); return render(); } };
}

function draft(id: string, content = "原正文"): Draft {
  return { id, content, title: id, platform: "douyin", accountId: "a", accountName: "账号", mode: "topic", prompt: "测试",
    createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", originalSourceInput: "原始素材\n\n\n排版",
    styleRef: { platform: "douyin", accountId: "a", accountName: "账号" },
    version: { sessionId: id, revision: 1, origin: "generated", contextFingerprint: "test", promptVersion: "test" } };
}

test("历史项目稿保留手动保存，但不会按默认账号重新生成或续改", async () => {
  let starts = 0;
  const state = writer(async input => ({ ...legacy, ...input, id: "manual-version" }));
  const legacy: Draft = { id: "legacy-project", targetType: "project", projectId: "project:legacy", projectName: "历史项目",
    title: "旧稿", content: "旧稿正文", mode: "topic", prompt: "原要求", createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
    styleRef: { projectId: "project:legacy", projectName: "历史项目" } };
  state.input.startTask = async () => { starts++; throw new Error("不应启动生成"); };
  state.render().loadDraftResult(legacy);
  assert.equal(state.render().canGenerate, false);
  assert.equal(state.render().canRevise, false);
  await state.render().handleGenerate();
  await state.render().handleRevise();
  assert.equal(starts, 0);
  state.render().handleContentChange("手动编辑旧稿");
  await state.render().handleSaveEdit();
  assert.equal(state.render().lastContent, "手动编辑旧稿");
  assert.equal(state.render().lastDraftBase?.targetType, "project");
  assert.equal(state.render().lastDraftVersion?.parentDraftId, legacy.id);
  state.render().clearDraftResult();
  assert.equal(state.render().canGenerate, true, "新建账号稿仍能生成");
});

test("保存期间继续编辑，切换独立稿件后保留新增正文与保存基线", async () => {
  let finishSave!: () => void;
  const state = writer(input => new Promise(resolve => { finishSave = () => resolve({ ...draft("saved"), ...input, id: "saved" }); }));
  state.render().loadDraftResult(draft("a"), [draft("a"), draft("b")]);
  state.render().handleContentChange("保存正文A");
  const pending = state.render().handleSaveEdit();
  state.render().handleContentChange("保存期间输入B");
  finishSave(); await pending;
  state.render().selectGeneratedVariant("b");
  state.render().selectGeneratedVariant("a");
  const current = state.render();
  assert.equal(current.lastContent, "保存期间输入B");
  assert.equal(current.lastDraftId, "saved");
  assert.equal(current.hasUnsavedChanges, true);
  assert.equal(current.lastDraftBase?.originalSourceInput, "原始素材\n\n\n排版");
  assert.equal(current.lastDraftVersion?.parentDraftId, "a");
});

test("首稿启动失败、生成失败、取消和中断都恢复全部独立稿件的未保存编辑", async () => {
  for (const outcome of ["start", "failed", "cancelled", "interrupted"] as const) {
    const state = writer(async () => { throw new Error("Unexpected save"); });
    state.render().loadDraftResult(draft("a"), [draft("a"), draft("b")]);
    state.render().handleContentChange("A未保存");
    state.render().selectGeneratedVariant("b");
    state.render().handleContentChange("B未保存");
    const job: JobRecord = { id: "job", kind: "write-copy", status: "queued", title: "测试", message: "准备", progress: 0,
      createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" };
    if (outcome !== "start") state.input.startTask = async () => job;
    await state.render().handleGenerate();
    if (outcome !== "start") {
      state.input.activeJobs = [{ ...job, status: "running", partialText: "半截生成" }];
      state.render(); state.syncJob();
      state.input.activeJobs = [];
      state.input.recentJobs = [{ ...job, status: outcome, partialText: "半截生成", error: "模拟失败" }];
      state.render(); state.syncJob();
    }
    assert.equal(state.render().lastContent, "B未保存", outcome);
    state.render().selectGeneratedVariant("a");
    assert.equal(state.render().lastContent, "A未保存", outcome);
    assert.equal(state.render().hasAnyUnsavedChanges, true);
  }
});

test("编号视频素材仍解析待转写链接，已解析的长文稿不重复转写", async () => {
  const file = "ai.ts", source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["normalizeRewriteSourceText", "isNormalizedMaterialText"].includes(node.name?.text || ""))
    .map(node => node.getText(ast)).join("\n");
  let calls = 0;
  const normalize = vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + "\nnormalizeRewriteSourceText", {
    extractRewriteSourceMaterial, resolveRewriteSourceMaterial: async () => { calls++; return { normalizedText: "已取得视频文稿" }; }
  }) as (source: string) => Promise<string>;
  assert.equal(await normalize("素材 1：\nhttps://www.douyin.com/video/123456"), "已取得视频文稿");
  assert.equal(calls, 1);
  const resolved = `素材 1：\n视频文稿：${"已解析正文。".repeat(40)}\n来源链接：https://www.douyin.com/video/123456`;
  assert.equal(await normalize(resolved), resolved);
  assert.equal(calls, 1);
});

test("取消或中断时已保存的续改同步显示，晚到版本只登记历史且保留当前编辑", async () => {
  for (const status of ["cancelled", "interrupted"] as const) {
    for (const delayed of [false, true]) {
      const state = writer(async () => { throw new Error("Unexpected save"); });
      const saved: string[] = [];
      state.input.onDraftSaved = item => { saved.push(item.id); };
      state.render().loadDraftResult(draft("a"));
      state.render().handleContentChange("未保存编辑");
      const job: JobRecord = { id: "revision", kind: "write-copy", status: "queued", title: "续改", message: "准备", progress: 0,
        createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" };
      state.input.startTask = async () => job;
      await state.render().handleRevise();
      const child = { ...draft("child", "已保存新正文"), version: { ...draft("a").version!, origin: "revision" as const, parentDraftId: "a", revision: 2 } };
      const result = { draft: child, content: child.content, usedModel: "mock", fallback: false };
      state.input.recentJobs = [{ ...job, status, ...(delayed ? {} : { dataRevision: 1, result }) }];
      state.render(); state.syncJob();
      if (delayed) {
        assert.equal(state.render().lastContent, "未保存编辑");
        state.render().handleContentChange("取消后继续输入");
        state.input.recentJobs = [{ ...job, status, dataRevision: 1, result }];
        state.render(); state.syncJob();
        assert.equal(state.render().lastContent, "取消后继续输入");
        assert.equal(state.render().lastDraftId, "a");
      } else {
        assert.equal(state.render().lastContent, "已保存新正文");
        assert.equal(state.render().lastDraftId, "child");
      }
      assert.deepEqual(saved, ["child"]);
    }
  }
});

test("已取消任务有更高数据修订时重新读取结果；读取失败不能合并旧结果为新版本", () => {
  const source = readFileSync(new URL("../src/components/TaskProvider.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("TaskProvider.tsx", source, ts.ScriptTarget.Latest, true);
  const names = ["shouldHydrateJob", "shouldExposeHydrationError", "isJobRelevantToHref", "isRecentJob", "mergeJobSummaries"];
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ""))
    .map(node => node.getText(ast)).join("\n");
  const functions = vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + "\n({ shouldHydrateJob, shouldExposeHydrationError, mergeJobSummaries })", {
    isActiveJob, isTerminalJob, defaultJobHref: () => "/writer"
  });
  const summary: JobListItem = { id: "job", kind: "write-copy", status: "cancelled", title: "写作", message: "已停止", progress: 88,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dataRevision: 2, hasResult: true, hasPartialText: false };
  const cache = new Map<string, JobRecord>([[summary.id, { ...summary, dataRevision: 1, result: { content: "旧部分结果" } }]]);
  assert.equal(functions.shouldHydrateJob(summary, 0, new Map(), cache, "/writer"), true);
  assert.equal(functions.shouldExposeHydrationError(summary), true);
  const [merged] = functions.mergeJobSummaries([summary], cache, new Map([[summary.id, "同步失败"]]), "/writer");
  assert.equal(merged.result, undefined);
  assert.equal(merged.error, "同步失败");
  cache.set(summary.id, { ...summary, result: { content: "新结果" } });
  assert.equal(functions.shouldHydrateJob(summary, 0, new Map(), cache, "/writer"), false);
});
