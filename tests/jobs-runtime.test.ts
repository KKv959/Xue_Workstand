import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { compactJobForPersistence, isResumableJobKind } from "../src/lib/job-persistence";
import { applyJobListResponse, isActiveJob, isTerminalJob, selectJobList } from "../src/lib/job-sync";
import { resolveWriteBatchOutcome, writeVariantFailure } from "../src/lib/ai";
import { startJobSchema } from "../src/lib/job-validation";
import { parseStoredRecord, STORAGE_SCHEMA_VERSION } from "../src/lib/storage/schemas";
import type { JobRecord } from "../src/lib/types";

const require = createRequire(import.meta.url);
const timestamp = "2026-01-01T00:00:00.000Z";
const record = (id: string, status: JobRecord["status"] = "running"): JobRecord => ({
  id, kind: "image-prompt-assist", status, title: "测试任务", message: "处理中", progress: 5, createdAt: timestamp, updatedAt: timestamp
});

// Compile in memory so failure injection cannot reach real storage, models or Workers.
function load(file: string, mocks: Record<string, unknown>, extra = "") {
  const sandboxModule = { exports: {} as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const context = { module: sandboxModule, exports: sandboxModule.exports, Buffer, process: { env: {} }, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (name: string) => mocks[name] ?? (["path", "crypto"].includes(name) ? require(name) : {}), console };
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8") + "\n" + extra, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, context, { filename: file });
  return sandboxModule.exports;
}

function localJobs(mocks: Record<string, unknown> = {}) {
  const disk = new Map<string, unknown>();
  let failing = false;
  const jobs = load("src/lib/jobs.ts", {
    "./storage": { libraryRoot: () => "/virtual" },
    "./storage/core": { normalizeStorageSegment: (id: string) => id },
    "./storage/schemas": { parseStoredRecord, STORAGE_SCHEMA_VERSION },
    "./storage/fs": { fileExists: async (p: string) => disk.has(p),
      readJsonFile: async (p: string) => disk.get(p) ?? null,
      writeJsonFile: async (p: string, value: unknown) => { if (failing) throw new Error("模拟落盘失败"); disk.set(p, value); },
      storageFs: { mkdir: async () => {}, readdir: async () => [], stat: async () => ({ mtimeMs: 0, size: 0 }), rm: async () => {} } },
    "./job-sync": { isActiveJob, isTerminalJob, selectJobList },
    "./job-persistence": { compactJobForPersistence, isResumableJobKind },
    "./job-validation": { startJobSchema },
    "./app-mode": { isJobKindAllowedForAppMode: () => true, assertJobKindAllowedForAppMode: () => {} },
    "./utils": { nowIso: () => new Date().toISOString() },
    "./concurrency": { mapWithConcurrency: async (items: unknown[], _limit: number, run: (item: unknown) => unknown) => Promise.all(items.map(run)) },
    "./observability": { logJobTransition: () => {} },
    ...mocks
  }, "exports.audit = { runtime, patchJob, patchJobWithDataChange, recoverStaleDiskJobs, runBatchTranscribeJob, runWriteCopyJob };" );
  jobs.audit.runtime.initialized = true;
  return { jobs, disk, fail: () => { failing = true; } };
}

test("联网准备失败时后台写作停止，不启动正文或发布检索成功状态", async () => {
  let generationCalls = 0;
  const { jobs } = localJobs({
    "./source-extraction": { splitWriterSourceInput: () => ({}), extractRewriteSourceMaterial: () => ({ pendingLinkCount: 0 }) },
    "./support-documents": { hasSupportDocumentReference: () => false },
    "./ai": {
      prepareWriteCopyBatchContext: async () => { throw new Error("模型联网搜索超时，本次未生成草稿"); },
      streamResponseTextWithFallback: async () => { generationCalls++; }
    }
  });
  jobs.audit.runtime.records.set("research-failure", { ...record("research-failure"), kind: "write-copy" });
  await assert.rejects(jobs.audit.runWriteCopyJob("research-failure", {
    kind: "write-copy", input: { mode: "topic", prompt: "测试", useWebResearch: true, save: true }
  }), /模型联网搜索超时/);
  assert.equal(generationCalls, 0);
  const job = jobs.audit.runtime.records.get("research-failure");
  assert.ok(!job.events?.some((event: { message: string }) => event.message.includes("联网检索已完成")));
  assert.equal(job.result, undefined);
  assert.equal(job.dataRevision, undefined);
});

test("多风格保持原有并发，失败仅汇总一次且不污染准备失败列表", async () => {
  let active = 0, peak = 0;
  const batch = { variants: Array.from({ length: 4 }, (_, i) => ({ styleKey: String(i), styleTitle: `风格${i}`, prepared: { messages: [] } })), preparationFailures: [] };
  const { jobs } = localJobs({
    "./source-extraction": { splitWriterSourceInput: () => ({}), extractRewriteSourceMaterial: () => ({ pendingLinkCount: 0 }) },
    "./support-documents": { hasSupportDocumentReference: () => false },
    "./ai": { WRITE_COPY_REASONING_EFFORT: "medium", resolveWriteBatchOutcome, writeVariantFailure,
      prepareWriteCopyBatchContext: async () => batch,
      streamResponseTextWithFallback: async () => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        throw new Error("对话模型服务超时");
      }
    }
  });
  jobs.audit.runtime.records.set("write", { ...record("write"), kind: "write-copy" });
  await assert.rejects(jobs.audit.runWriteCopyJob("write", { kind: "write-copy", input: { mode: "topic", prompt: "测试", save: false } }), (error: Error) => {
    assert.equal((error.message.match(/对话模型服务超时/g) || []).length, 4);
    return true;
  });
  assert.equal(peak, 4);
  assert.deepEqual(batch.preparationFailures, []);
});

test("状态写入失败不发布假终态或增量版本；已取消任务仍记录已保存资产", async () => {
  const { jobs, disk, fail } = localJobs();
  jobs.audit.runtime.records.set("save", record("save"));
  fail();
  await assert.rejects(jobs.audit.patchJob("save", { status: "completed" }), /模拟落盘失败/);
  assert.equal(jobs.audit.runtime.records.get("save").status, "running");
  assert.equal(jobs.audit.runtime.changeRevision, 0);
  assert.equal(disk.size, 0);

  const other = localJobs();
  other.jobs.audit.runtime.records.set("cancel", record("cancel", "cancelled"));
  await other.jobs.audit.patchJobWithDataChange("cancel", { message: "已保存", status: "running" }, { resource: "library-account", accountId: "account" });
  const saved = other.disk.get("/virtual/jobs/cancel.json") as JobRecord;
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.message, "处理中");
  assert.equal(saved.dataRevision, 1);
});

test("恢复错误保留原文件且不作为活跃任务；历史上限不丢活跃任务", async () => {
  const { jobs, disk } = localJobs();
  const original = record("legacy");
  disk.set("/virtual/jobs/legacy.json", original);
  disk.set("/virtual/jobs/.payloads/legacy.json", { version: 2 });
  await jobs.audit.recoverStaleDiskJobs([{ ...original, filePath: "/virtual/jobs/legacy.json" }]);
  const detail = await jobs.getJob("legacy");
  assert.equal(detail.status, "running");
  assert.match(detail.recoveryError, /版本不支持/);
  assert.equal(isActiveJob(detail), false);
  assert.equal(disk.get("/virtual/jobs/legacy.json"), original);
  const history = Array.from({ length: 100 }, (_, i) => ({ ...record(`done-${i}`, "completed"), updatedAt: new Date(Date.now() + i).toISOString() }));
  jobs.audit.runtime.records.set("active", record("active"));
  history.forEach(job => jobs.audit.runtime.records.set(job.id, job));
  assert.equal((await jobs.listJobSummaries()).length, 81);
  const selected = selectJobList([record("active"), ...history]);
  assert.equal(selected.length, 81);
  assert.equal(selected.some(job => job.id === "active"), true);
  const [unrecoverable] = applyJobListResponse([{ ...record("active"), hasPartialText: false, hasResult: false }], {
    jobs: [], removedJobIds: [], cursor: "epoch.1", reset: false, recoveryErrors: { active: "恢复失败" }
  });
  assert.equal(isActiveJob(unrecoverable), false, "无增量记录时仍同步恢复错误");
});

test("批次执行器先持久化候选，再逐条发布数据版本；空候选不会扩大范围", async () => {
  const { jobs, disk } = localJobs({ "./batch-transcribe": { runBatchTranscribe: async (_input: unknown, hooks: {
    onCandidates: (ids: string[]) => Promise<void>; onVideoResult: (event: unknown) => Promise<void>
  }) => {
    await hooks.onCandidates([]);
    assert.deepEqual((disk.get("/virtual/jobs/.payloads/batch.json") as { input: { input: { videoIds: string[] } } }).input.input.videoIds, []);
    await hooks.onVideoResult({ title: "视频", videoId: "one", status: "completed" });
    assert.equal((disk.get("/virtual/jobs/batch.json") as JobRecord).dataRevision, 1);
    throw new Error("模拟后续失败");
  } } });
  jobs.audit.runtime.records.set("batch", { ...record("batch"), kind: "batch-transcribe" });
  await assert.rejects(jobs.audit.runBatchTranscribeJob("batch", {
    kind: "batch-transcribe", input: { platform: "bilibili", accountId: "test", limit: 5 }
  }), /模拟后续失败/);
  assert.equal((disk.get("/virtual/jobs/batch.json") as JobRecord).dataChange?.videoId, "one");
});

test("无独立资产的大结果完整保留，已保存草稿才可压缩", () => {
  const result = { text: "文".repeat(40000) };
  for (const kind of ["single-video-transcribe", "publish-copy", "image-prompt-assist", "write-copy"] as const) {
    assert.equal(compactJobForPersistence({ ...record(kind, "completed"), kind, result }).result, result);
  }
  assert.equal(compactJobForPersistence({ ...record("saved", "completed"), kind: "write-copy", result: { draft: { id: "draft" }, content: result.text } }).result, undefined);
});

test("批量候选先保存且恢复沿用 IDs；结果检查点失败不污染已完成转写", async () => {
  const videos = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: String(i), transcriptStatus: "not_started" }));
  const processed: string[] = [];
  let candidates: string[] = [];
  const batch = load("src/lib/batch-transcribe.ts", {
    "./storage": { resolveAccount: async () => ({}), getAccountSummary: async () => ({ videos }) },
    "./transcription": { transcribeVideo: async (input: { videoId: string }) => { processed.push(input.videoId); return { video: {} }; } }
  });
  await assert.rejects(batch.runBatchTranscribe({ platform: "bilibili", accountId: "test", limit: 5 }, {
    onCandidates: async (ids: string[]) => { candidates = ids; },
    onVideoResult: async () => { throw new Error("检查点写入失败"); }
  }), /检查点写入失败/);
  assert.deepEqual([...candidates], ["0", "1", "2", "3", "4"]);
  assert.deepEqual(processed, ["0"]);
  videos[0].transcriptStatus = "completed";
  processed.length = 0;
  await batch.runBatchTranscribe({ platform: "bilibili", accountId: "test", limit: 5, videoIds: candidates });
  assert.deepEqual(processed, ["1", "2", "3", "4"]);
  processed.length = 0;
  await batch.runBatchTranscribe({ platform: "bilibili", accountId: "test", limit: "all", videoIds: [] });
  assert.deepEqual(processed, []);
});

test("并行批次检查点失败停止领新项，并等待在途保存", async () => {
  const videos = Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: String(i), transcriptStatus: "not_started" }));
  const processed: string[] = [];
  const saved: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const batch = load("src/lib/batch-transcribe.ts", {
    "./storage": { resolveAccount: async () => ({}), getAccountSummary: async () => ({ videos }) },
    "./opencli": { getDouyinVideoDownloadLookupLimit: () => 8, getDouyinVideoDownloadUrls: async () => new Map(), getDouyinAwemeId: () => "" },
    "./transcription": { transcribeVideo: async (input: { videoId: string }) => {
      processed.push(input.videoId);
      if (input.videoId !== "0") await pending;
      return { video: {} };
    } }
  });
  let settled = false;
  const run = batch.runBatchTranscribe({ platform: "douyin", accountId: "test", limit: 8 }, {
    onVideoResult: async (event: { videoId: string }) => {
      if (event.videoId === "0") throw new Error("检查点写入失败");
      saved.push(event.videoId);
    }
  });
  const checked = assert.rejects(run, /检查点写入失败/).then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  assert.deepEqual(processed, ["0", "1", "2"]);
  release();
  await checked;
  assert.deepEqual(saved, ["1", "2"]);
  assert.deepEqual(processed, ["0", "1", "2"]);
});
