import assert from "node:assert/strict";
import { readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as apiRoute from "../src/lib/api-route";
import * as platformLinks from "../src/lib/platform-links";
import * as utils from "../src/lib/utils";
import * as grossMarginProjects from "../src/lib/gross-margin-projects";
import { parseDate } from "@internationalized/date";
import { calculateGrossMargin, makeEmptyQuantityInputs, parseGrossMarginAmount, parseGrossMarginMetric } from "../src/lib/gross-margin-calculator";
import { buildGrossMarginTemplateValues, formatImportedQuantity } from "../src/app/gross-margin/_lib/gross-margin-workbench-model";
import { getGrossMarginLibrary, invalidateGrossMarginLibraryCache, saveGrossMarginPriceTable as saveClientTable } from "../src/lib/client";
import { getGrossMarginLibrary as readLibrary, saveGrossMarginPriceTable, upsertGrossMarginMonitorRecord, updateGrossMarginMonitorRecord } from "../src/lib/storage/gross-margin";
import { parseStoredRecord } from "../src/lib/storage/schemas";
import { isJobKindAllowedForAppMode } from "../src/lib/app-mode";
import type { AccountSourceResult } from "../src/lib/wecom-account-source";
import type { GrossMarginMonitorRecord, GrossMarginPriceTable } from "../src/lib/types";

const timestamp = "2026-01-01T00:00:00.000Z";

test("切换账号清空返点后，新账号报价不沿用上一笔尚未提交的返点状态", () => {
  const source = readFileSync("src/app/gross-margin/_hooks/useGrossMarginWorkbench.ts", "utf8");
  const handler = source.match(/  function updateOriginalPrice\(value: string\) \{[\s\S]*?\n  \}/)![0];
  let original = "";
  let discount = "";
  const rebateRateRef = { current: "" };
  const run = vm.runInNewContext(ts.transpileModule(`${handler}\nupdateOriginalPrice`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    rebateRate: "25", rebateRateRef,
    setOriginalPrice: (value: string) => { original = value; },
    setDiscountPrice: (value: string) => { discount = value; },
    toAmount: Number, formatAmountInput: String
  });
  run("3000");
  assert.equal(original, "3000");
  assert.equal(discount, "");
  rebateRateRef.current = "20";
  run("12000");
  assert.equal(discount, "9600");
});
const table: GrossMarginPriceTable = { platform: "douyin", updatedAt: timestamp, items: [{
  id: "play", service: "play", name: "播放", unitPrice: 1.005, quantityUnit: "个", updatedAt: timestamp
}] };

test("金额按分舍入；非法和空单价阻止导出；单位转换不损失精度", () => {
  const input = { configs: [{ service: "play" as const, label: "播放" }], discountPrice: 10, originalPrice: 10,
    priceInputs: {}, quantityInputs: { ...makeEmptyQuantityInputs(), play: "1" }, selectedOptions: {}, table };
  assert.equal(calculateGrossMargin(input).maintenanceCost, 1.01);
  assert.equal(calculateGrossMargin(input).grossProfit, 8.99);
  for (const price of ["-2", "Infinity", "NaN", "0x10", "", "1e9"]) {
    assert.ok(calculateGrossMargin({ ...input, priceInputs: { play: price } }).errors?.length, price);
  }
  assert.ok(calculateGrossMargin({ ...input, quantityInputs: { ...input.quantityInputs, play: "-2" } }).errors?.length);
  assert.equal(parseGrossMarginAmount("0"), 0);
  for (const raw of ["2万错误", "-1", "Infinity", "100000001", ""]) assert.equal(parseGrossMarginMetric(raw), null);
  assert.equal(formatImportedQuantity("2万", "个"), "20000");
  assert.equal(formatImportedQuantity("1.5千", "万"), "0.15");
  assert.equal(formatImportedQuantity("1.2345万", "万"), "1.2345");
  const calculation = calculateGrossMargin({ ...input, configs: [{ service: "comment", label: "评论" }],
    quantityInputs: { ...makeEmptyQuantityInputs(), comment: "1" }, table: null });
  const values = buildGrossMarginTemplateValues({ calculation, account: null, accountName: "测试", platform: "douyin", videoUrl: "", splitDeliveryEnabled: true });
  assert.equal(values.splitRoundLine, "分两轮维护：第一轮，评论1");
});

// Memory compilation injects every external capability; no real CLI or data can be reached.
function load<T>(file: string, mocks: Record<string, unknown>, env: Record<string, string> = {}) {
  const sandbox = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, { module: sandbox, exports: sandbox.exports, require: (name: string) => {
    if (!(name in mocks)) throw new Error(`未 mock 的依赖：${name}`);
    return mocks[name];
  }, process: { env }, Error, Date, setTimeout, clearTimeout, console: { log() {}, warn() {} } });
  return sandbox.exports as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

test("导出监控和保存单价接受必火字段，仍拒绝未知服务", async () => {
  const saved: Array<{ projectName?: string; targetStats?: { mustFire?: number }; items?: Array<{ service: string }> }> = [];
  const route = load<typeof import("../src/app/api/gross-margin/route")>("src/app/api/gross-margin/route.ts", {
    zod: { z },
    "@/lib/api-route": apiRoute,
    "@/lib/gross-margin-monitor-template": {},
    "@/lib/gross-margin-refresh": {},
    "@/lib/storage/gross-margin-projects": {},
    "@/lib/gross-margin-projects": grossMarginProjects,
    "@/lib/platform-links": platformLinks,
    "@/lib/utils": utils,
    "@/lib/gross-margin-calculator": { parseGrossMarginAmount, parseGrossMarginMetric },
    "@/lib/storage": {
      getGrossMarginLibrary: async () => ({}),
      upsertGrossMarginMonitorRecord: async (input: typeof saved[number]) => { saved.push(input); return input; },
      saveGrossMarginPriceTable: async (input: typeof saved[number]) => { saved.push(input); return input; }
    }
  });
  const post = (body: unknown) => route.POST(new Request("http://localhost/api/gross-margin", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }));
  const monitor = { action: "saveMonitorRecord", platform: "bilibili", accountName: "测试",
    videoUrl: "https://www.bilibili.com/video/BV12Vpt62ERk", sourceText: "【B站】\n账号：测试", projectName: "所选项目", targetStats: { mustFire: 2000 } };
  const result = await post(monitor);
  assert.equal(result.status, 200, JSON.stringify(await result.json()));
  assert.equal(saved[0].targetStats?.mustFire, 2000);
  assert.equal(saved[0].projectName, "所选项目");
  const price = await post({ action: "savePriceTable", platform: "bilibili", items: [{
    id: "bilibili-must-fire", service: "mustFire", name: "默认", unitPrice: 1, quantityUnit: "元"
  }] });
  assert.equal(price.status, 200);
  assert.equal(saved[1].items?.[0].service, "mustFire");
  assert.equal((await post({ ...monitor, targetStats: { unknownService: 1 } })).status, 400);
  assert.equal(saved.length, 2);
});

function sheet(price = "20") {
  return `抖音\n|账号昵称|平台|抖音ID|植入价格;（含税不含平台费）|定制价格;（含税不含平台费）|\n|---|---|---|---|---|\n|Good|抖音|good|0|10|\n|Bad|抖音|bad|5|${price}|`;
}

function accountSource(command: () => Promise<{ stdout: string }>, fallback = "1") {
  return load<typeof import("../src/lib/wecom-account-source")>("src/lib/wecom-account-source.ts", {
    child_process: { execFile() {} }, util: { promisify: () => command }
  }, { WECOM_ACCOUNT_SHEET_URL: "https://sheet.invalid/test", WECOM_ACCOUNT_SHEET_FALLBACK_LOCAL: fallback });
}

function response(markdown: string) {
  return { stdout: JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ task_done: true, content: markdown }) }] } }) };
}

test("连续筛选合并最新 URL，清空时保留无关参数", () => {
  const source = ts.createSourceFile("monitor.tsx", readFileSync("src/app/gross-margin/monitor/page.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions: string[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && ["updateFilters", "setOptionalQueryParam"].includes(node.name?.text || "")) functions.push(node.getText(source));
    ts.forEachChild(node, collect);
  };
  collect(source);
  const location = { pathname: "/gross-margin/monitor", search: "?keep=1" };
  const update = vm.runInNewContext(ts.transpileModule(`${functions.join("\n")}\nupdateFilters`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    URLSearchParams, pathname: location.pathname, window: { location, history: { replaceState: (_state: unknown, _title: string, href: string) => { location.search = new URL(href, "http://localhost").search; } } }
  });
  update({ from: "2026-09-01" });
  update({ account: "海电工厂" });
  update({ to: "2026-09-30", q: "测试" });
  assert.equal(new URLSearchParams(location.search).get("from"), "2026-09-01");
  assert.equal(new URLSearchParams(location.search).get("account"), "海电工厂");
  update({ q: "", account: "", project: "", from: "", to: "" });
  assert.equal(location.search, "?keep=1");
});

test("日历筛选忽略 URL 中不存在的日期，保留合法闰日", () => {
  const source = ts.createSourceFile("monitor.tsx", readFileSync("src/app/gross-margin/monitor/page.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "parseDateFilter")!;
  const parse = vm.runInNewContext(ts.transpileModule(`${node.getText(source)}\nparseDateFilter`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { parseDate });
  for (const value of [null, "", "2026-02-29", "2026-13-01", "2026-10-00", "wrong"]) assert.equal(parse(value), "");
  assert.equal(parse("2024-02-29"), "2024-02-29");
});

test("企业微信授权过期保留成功缓存，并显示中文处理方式", async () => {
  const source = accountSource(async () => ({ stdout: JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({
    errcode: 851014, errmsg: "authorization expired, hint: [123], from ip: 192.0.2.1"
  }) }] } }) }));
  const persisted: AccountSourceResult = { accounts: source.parseWecomAccountSheet(sheet("30")), source: "wecom", fetchedAt: timestamp };
  const result = await source.resolveGrossMarginAccounts([], { persisted, refresh: true });
  assert.equal(result.accounts[1].defaultPrice, 30);
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "企业微信文档授权已过期，请在机器人「可使用权限」中重新授权；管理员授权模式请联系管理员处理");
  assert.match(result.warning || "", /上次成功缓存.*企业微信文档授权已过期/);
  assert.doesNotMatch(result.warning || "", /wecom-cli init/);
  assert.doesNotMatch(result.warning || "", /authorization expired|192\.0\.2\.1|hint/);
});

test("账号表单飞刷新，落盘前保持旧缓存；部分解析/落盘失败显式回退且冷却", async () => {
  const pending = deferred<{ stdout: string }>();
  let calls = 0, saves = 0;
  const source = accountSource(async () => { calls++; return pending.promise; });
  const persisted: AccountSourceResult = { accounts: source.parseWecomAccountSheet(sheet("30")), source: "wecom", fetchedAt: timestamp };
  const save = deferred<void>();
  const options = { persisted, onFresh: async () => { saves++; await save.promise; } };
  const first = await source.resolveGrossMarginAccounts([], options);
  await source.resolveGrossMarginAccounts([], options);
  const fresh = source.resolveGrossMarginAccounts([], { ...options, refresh: true });
  assert.equal(first.refreshing, true);
  assert.equal(calls, 1);
  pending.resolve(response(sheet("40")));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await source.resolveGrossMarginAccounts([], { cachedOnly: true })).accounts[1].defaultPrice, 30);
  save.resolve();
  assert.equal((await fresh).accounts[1].defaultPrice, 40);
  assert.equal(saves, 1);
  assert.equal((await source.resolveGrossMarginAccounts([], { cachedOnly: true })).refreshing, false);
  for (const failure of ["parse", "save"]) {
    let attempts = 0;
    const failing = accountSource(async () => { attempts++; return response(sheet(failure === "parse" ? "待更新" : "50")); });
    const result = await failing.resolveGrossMarginAccounts([], { persisted, refresh: true, onFresh: async () => { throw new Error("缓存落盘失败"); } });
    assert.equal(result.accounts.length, 2);
    assert.equal(result.accounts[1].defaultPrice, 30);
    assert.equal(result.fallback, true);
    assert.ok(result.fallbackReason);
    assert.equal((await failing.resolveGrossMarginAccounts([])).fallback, true);
    assert.equal(attempts, 1);
    assert.throws(() => failing.parseWecomAccountSheet(sheet("待更新")), /无效/);
  }
  const strict = accountSource(async () => response(sheet("待更新")), "0");
  await strict.resolveGrossMarginAccounts([], { persisted });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(strict.resolveGrossMarginAccounts([], { cachedOnly: true }), /读取企业微信账号表失败/);
});

test("监控故障保留数值、部分成功合并；迟到刷新不能覆盖新 revision", async () => {
  let current = { id: "test", revision: 1, platform: "bilibili", accountName: "测试", videoUrl: "https://video.invalid/test",
    videoKey: "test", sourceText: "", targetStats: {}, currentStats: { play: 100, like: 80, comment: 30, favorite: 20, share: 10 },
    metrics: [], maxDifferencePercent: 0, highRisk: false, status: "completed", warnings: [], createdAt: timestamp, updatedAt: timestamp } as GrossMarginMonitorRecord;
  let fetchStats: () => Promise<unknown> = async () => { throw new Error("抓取失败"); };
  const refresh = load<typeof import("../src/lib/gross-margin-refresh")>("src/lib/gross-margin-refresh.ts", {
    "./concurrency": {}, "./opencli": { getBilibiliVideoStatsByUrl: () => fetchStats() },
    "./platform-links": { getVideoComparableKey: () => "test" }, "./utils": { shortHash: () => "test" },
    "./storage": { resolveGrossMarginMonitorRecord: async () => current,
      appendGrossMarginPlaySample: (samples: unknown) => samples,
      updateGrossMarginMonitorRecord: async (_id: string, update: (record: GrossMarginMonitorRecord) => GrossMarginMonitorRecord, revision: number) => {
        if (revision !== current.revision) throw Object.assign(new Error("版本冲突"), { statusCode: 409 });
        current = { ...update(current), revision: (current.revision || 0) + 1 };
        return current;
      } }
  });
  await refresh.refreshGrossMarginMonitorRecord("test");
  assert.equal(current.status, "failed");
  assert.equal(current.currentStats?.like, 80);
  fetchStats = async () => ({ stats: { play: 200, like: -1, comment: Number.NaN } });
  await refresh.refreshGrossMarginMonitorRecord("test");
  assert.equal(current.status, "partial");
  assert.equal(current.currentStats?.play, 200);
  assert.equal(current.currentStats?.comment, 30);
  const old = deferred<unknown>(), newer = deferred<unknown>();
  let requests = 0;
  fetchStats = () => (++requests === 1 ? old.promise : newer.promise);
  const first = refresh.refreshGrossMarginMonitorRecord("test");
  const second = refresh.refreshGrossMarginMonitorRecord("test");
  await new Promise(resolve => setImmediate(resolve));
  newer.resolve({ stats: { play: 300 } });
  await second;
  old.resolve({ stats: { play: 150 } });
  await first;
  assert.equal(current.currentStats?.play, 300);
});

test("客户端合并普通读取，刷新独立且去重，旧响应不能覆盖保存结果", async () => {
  const previousFetch = globalThis.fetch;
  const pending = deferred<Response>();
  let calls = 0;
  invalidateGrossMarginLibraryCache();
  try {
    globalThis.fetch = async url => { calls++; assert.equal(url, "/api/gross-margin"); return pending.promise; };
    const old = getGrossMarginLibrary();
    assert.equal(getGrossMarginLibrary(), old);
    globalThis.fetch = async url => { calls++; assert.equal(url, "/api/gross-margin?refreshAccounts=1"); return Response.json({ root: "fresh" }); };
    const fresh = getGrossMarginLibrary({ fresh: true });
    assert.equal(getGrossMarginLibrary({ fresh: true }), fresh);
    await fresh;
    pending.resolve(Response.json({ root: "old" }));
    assert.equal((await old).root, "fresh");
    assert.equal(calls, 2);
    const stale = deferred<Response>();
    globalThis.fetch = async url => { assert.equal(url, "/api/gross-margin?cachedAccounts=1"); return stale.promise; };
    const reading = getGrossMarginLibrary({ revalidate: true });
    globalThis.fetch = async () => Response.json({ table, library: { root: "saved" } });
    await saveClientTable({ platform: "douyin", items: [] });
    stale.resolve(Response.json({ root: "stale" }));
    assert.equal((await reading).root, "saved");
    assert.equal((await getGrossMarginLibrary()).root, "saved");
  } finally { globalThis.fetch = previousFetch; invalidateGrossMarginLibraryCache(); }
});

test("临时库保留清空起量与零报价；损坏与新版拒读；更新校验 revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gross-margin-safety-"));
  const previous = { STYLE_LIBRARY_DIR: process.env.STYLE_LIBRARY_DIR, WECOM_ACCOUNT_SHEET_URL: process.env.WECOM_ACCOUNT_SHEET_URL };
  process.env.STYLE_LIBRARY_DIR = root;
  process.env.WECOM_ACCOUNT_SHEET_URL = "";
  try {
    const initial = await readLibrary();
    const item = initial.tables[0].items.find(option => option.minimumQuantity)!;
    await saveGrossMarginPriceTable({ platform: "douyin", items: [{ ...item, minimumQuantity: null }] });
    await fs.writeFile(path.join(root, "gross-margin/accounts.json"), JSON.stringify([{ platform: "douyin", name: "零植入", defaultPrice: 10, secondaryPrice: 0 }]));
    const library = await readLibrary();
    assert.equal(library.tables[0].items.find(option => option.id === item.id)?.minimumQuantity, null);
    assert.equal(library.accounts[0].secondaryPrice, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "gross-margin/douyin.json"), "utf8")).schemaVersion, 1);
    const created = await upsertGrossMarginMonitorRecord({ platform: "douyin", accountName: "测试", videoUrl: "https://video.invalid/test", videoKey: "test", sourceText: "测试", targetStats: { play: 100 } });
    await updateGrossMarginMonitorRecord(created.id, current => ({ ...current, currentStats: { play: 123456 } }), created.revision);
    await assert.rejects(updateGrossMarginMonitorRecord(created.id, current => current, created.revision), error => (error as { statusCode?: number }).statusCode === 409);
    assert.throws(() => parseStoredRecord("table", { ...table, schemaVersion: 999 }, "gross-margin-table"), /版本过新/);
    await fs.writeFile(path.join(root, "gross-margin/douyin.json"), JSON.stringify({ ...table, items: [{ ...table.items[0], unitPrice: -1 }] }));
    await assert.rejects(readLibrary(), /存储记录结构无效/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("毛利模式仅允许毛利刷新任务，完整工作台保留写作任务", () => {
  assert.equal(isJobKindAllowedForAppMode("gross-margin-refresh", "gross-margin"), true);
  assert.equal(isJobKindAllowedForAppMode("write-copy", "gross-margin"), false);
  assert.equal(isJobKindAllowedForAppMode("write-copy", "workspace"), true);
});

test("剪贴板受限仍保存监控并提供手动复制入口，保存失败不报成功", async () => {
  const source = ts.createSourceFile("workbench.ts", readFileSync("src/app/gross-margin/_hooks/useGrossMarginWorkbench.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let handler = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "handleExportReview") handler = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const clipboardMode of ["allowed", "denied", "missing"]) {
    for (const saveFails of [false, true]) {
      let saves = 0, opened = false;
      const notices: Array<{ tone: string; message: string; action?: { onClick: () => void } }> = [];
      const busyStates: string[] = [];
      const run = vm.runInNewContext(ts.transpileModule(`${handler}\nhandleExportReview`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
        busy: "", validationError: "", videoUrl: "https://www.bilibili.com/video/BV12Vpt62ERk", renderedReviewTemplate: { error: "" },
        effectiveReviewTemplate: "昨日文案", reviewTemplate: { content: "日期：{{date}}" }, reviewTemplateValues: {},
        renderGrossMarginReviewTemplate: () => "当日文案",
        platform: "bilibili", matchedAccount: null, accountName: "测试", selectedProject: null, calculation: { lines: [] },
        copyText: async (text: string) => { assert.equal(text, "当日文案"); if (clipboardMode !== "allowed") throw new Error("NotAllowedError"); },
        saveGrossMarginMonitorRecord: async (input: { sourceText: string }) => {
          assert.equal(input.sourceText, "当日文案");
          saves++; if (saveFails) throw new Error("保存失败"); return { library: {} };
        },
        setLibrary() {}, setBusy: (value: string) => busyStates.push(value), setTemplateModalOpen: (value: boolean) => { opened = value; },
        notify: (value: typeof notices[number]) => notices.push(value), Error
      });
      await run();
      assert.equal(saves, 1);
      assert.equal(busyStates.at(-1), "");
      assert.equal(notices[0].tone, saveFails ? "error" : clipboardMode === "allowed" ? "success" : "warning");
      if (!saveFails && clipboardMode !== "allowed") {
        assert.match(notices[0].message, /监控目标已保存/);
        notices[0].action?.onClick();
        assert.equal(opened, true);
      }
    }
  }
});

test("必火手动金额复用记录锁与revision，接受零，拒绝非法输入和版本冲突", async () => {
  const initial = { id: "bilibili-manual", revision: 2, platform: "bilibili", targetStats: { mustFire: 2000 }, currentStats: { play: 100 }, updatedAt: timestamp };
  let current = { ...initial, currentStats: { ...initial.currentStats } } as unknown as GrossMarginMonitorRecord;
  const route = load<typeof import("../src/app/api/gross-margin/route")>("src/app/api/gross-margin/route.ts", {
    zod: { z }, "@/lib/api-route": apiRoute,
    "@/lib/gross-margin-monitor-template": {}, "@/lib/gross-margin-refresh": {},
    "@/lib/storage/gross-margin-projects": {},
    "@/lib/gross-margin-projects": grossMarginProjects, "@/lib/platform-links": platformLinks,
    "@/lib/utils": utils, "@/lib/gross-margin-calculator": { parseGrossMarginAmount, parseGrossMarginMetric },
    "@/lib/storage": {
      getGrossMarginLibrary: async () => ({}),
      updateGrossMarginMonitorRecord: async (_id: string, update: (record: GrossMarginMonitorRecord) => GrossMarginMonitorRecord, revision: number) => {
        if (revision !== current.revision) throw Object.assign(new Error("记录已更新，请刷新"), { statusCode: 409 });
        current = { ...update(current), revision: revision + 1 };
        return current;
      }
    }
  });
  const post = (amount: number, revision = current.revision) => route.POST(new Request("http://localhost/api/gross-margin", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "updateMonitorMustFireCurrent", recordId: current.id, current: amount, revision })
  }));
  assert.equal((await post(600)).status, 200);
  assert.equal(current.currentStats?.mustFire, 600);
  assert.equal(current.currentStats?.play, 100);
  assert.equal((await post(0)).status, 200);
  assert.equal(current.currentStats?.mustFire, 0);
  assert.equal((await post(-1)).status, 400);
  assert.equal((await post(1.5)).status, 400);
  assert.equal((await post(100_000_001)).status, 400);
  assert.equal((await post(900, 2)).status, 409);
  assert.equal(current.currentStats?.mustFire, 0);
  current = { ...current, platform: "douyin" };
  assert.equal((await post(600)).status, 400);
});

test("维护项目独立持久化；导出与补选读取同一项目表，保留指标和分组并校验 revision", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-project-choice-"));
  const previous = process.env.STYLE_LIBRARY_DIR;
  process.env.STYLE_LIBRARY_DIR = dir;
  try {
    const source = { month: "2026-10", stale: false, orders: [
      { id: "edifier-order", month: "2026-10", platform: "bilibili" as const, accountName: "上官北丶", projectName: "漫步者耳机", orderAmount: null, rebateAmount: null, finalPrice: null, videoUrl: "", date: "10月15日" },
      { id: "kaidu-order", month: "2026-10", platform: "bilibili" as const, accountName: "上官北", projectName: "凯度微蒸烤箱", orderAmount: null, rebateAmount: null, finalPrice: null, videoUrl: "", date: "" },
      { id: "other-account", month: "2026-10", platform: "bilibili" as const, accountName: "其他账号", projectName: "不可选项目", orderAmount: null, rebateAmount: null, finalPrice: null, videoUrl: "", date: "" }
    ] };
    const videoUrl = "https://www.bilibili.com/video/BV12Vpt62ERk";
    const created = await upsertGrossMarginMonitorRecord({ platform: "bilibili", accountName: "上官北", projectId: "batch-1", projectName: "批量监控分组", videoUrl, videoKey: platformLinks.getVideoComparableKey(videoUrl), sourceText: "原目标文案", targetStats: { play: 10000 } });
    const current = await updateGrossMarginMonitorRecord(created.id, record => ({ ...record, title: "原视频标题", currentStats: { play: 1234 }, playSamples: [{ value: 1234, capturedAt: timestamp, source: "refresh" }] }), created.revision);
    const route = load<typeof import("../src/app/api/gross-margin/route")>("src/app/api/gross-margin/route.ts", {
      zod: { z }, "@/lib/api-route": apiRoute, "@/lib/gross-margin-monitor-template": {}, "@/lib/gross-margin-refresh": {},
      "@/lib/storage/gross-margin-projects": { getGrossMarginProjectSource: async () => source },
      "@/lib/gross-margin-projects": grossMarginProjects, "@/lib/platform-links": platformLinks, "@/lib/utils": utils,
      "@/lib/gross-margin-calculator": { parseGrossMarginAmount, parseGrossMarginMetric },
      "@/lib/storage": { upsertGrossMarginMonitorRecord, updateGrossMarginMonitorRecord, getGrossMarginLibrary: readLibrary }
    });
    const post = (body: unknown) => route.POST(new Request("http://localhost/api/gross-margin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const choice = { action: "updateMonitorProject", recordId: current.id, projectOrderId: "edifier-order", revision: current.revision };
    const chosenResponse = await post(choice);
    assert.equal(chosenResponse.status, 200);
    const chosen = (await chosenResponse.json()).record as GrossMarginMonitorRecord;
    assert.deepEqual(chosen.maintenanceProject, { orderId: "edifier-order", name: "漫步者耳机" });
    assert.equal(chosen.projectName, "批量监控分组");
    assert.equal(chosen.title, "原视频标题");
    assert.deepEqual(chosen.currentStats, current.currentStats);
    assert.deepEqual(chosen.playSamples, current.playSamples);
    assert.equal((await post(choice)).status, 409);
    assert.equal((await post({ ...choice, revision: chosen.revision, projectOrderId: "other-account" })).status, 400);
    assert.equal((await post({ ...choice, revision: chosen.revision, projectOrderId: "" })).status, 400);
    const reloaded = (await readLibrary({ cachedAccountsOnly: true })).monitorRecords.find(record => record.id === chosen.id)!;
    assert.deepEqual(reloaded.maintenanceProject, chosen.maintenanceProject);
    assert.throws(() => parseStoredRecord("record.json", { ...chosen, maintenanceProject: { orderId: "", name: "" } }, "gross-margin-monitor"), /存储记录结构无效/);
    const exportedResponse = await post({ action: "saveMonitorRecord", platform: "bilibili", accountName: "上官北", videoUrl, sourceText: "【B站】\n账号：上官北", targetStats: { play: 10000 }, projectOrderId: "kaidu-order" });
    assert.equal(exportedResponse.status, 200);
    assert.deepEqual((await exportedResponse.json()).record.maintenanceProject, { orderId: "kaidu-order", name: "凯度微蒸烤箱" });
  } finally {
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
