import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseGrossMarginProjectOrder, findGrossMarginProjectOrders, getGrossMarginMonitorProjectName, getGrossMarginProjectMonth, getGrossMarginProjectPrices, getGrossMarginProjectSyncError, parseWecomProjectSheet } from "../src/lib/gross-margin-projects";
import type { GrossMarginMonitorRecord, GrossMarginProjectSource, JobRecord } from "../src/lib/types";
import { getGrossMarginProjectSource, syncGrossMarginProjectSource } from "../src/lib/storage/gross-margin-projects";
import { startJobSchema } from "../src/lib/job-validation";

const header = "|平台|账号|投放产品|链接|下单金额|返点金额|最终合作价格|实际发布日期|账号|";
const separator = "|---|---|---|---|---|---|---|---|---|";
const fixture = [
  "25.10月", header, separator,
  "|B站|薛定谔的机|旧年项目||8000|800|7200|10月1日||",
  "26.9月", header, separator,
  "|B站|薛定谔的机|上月项目||8000|800|7200|9月1日||",
  "26.10月", header, separator,
  "|B站|薛定谔的机|凯度微蒸烤箱|[视频](https://www.bilibili.com/video/BV1ArWc6qEVK/?share_source=copy_web)|12,000|2400|9600|10月13日||",
  "|B站|薛定谔的机|脑花AI NPC||12000|3000|9000|10月22日|不应读取这个账号|",
  "|抖音|薛定谔的机|同名跨平台||20000|5000|14000|10月13日||",
  "26.11月", header, separator,
  "|B站|薛定谔的机|下月项目||12000|1200|10800|11月1日||"
].join("\n");

test("手动同步失败时明确提示是否有可用缓存", () => {
  const now = Date.parse("2026-10-15T01:00:00Z");
  const source: GrossMarginProjectSource = { month: "2026-10", orders: [], stale: true };
  const failed: JobRecord = { id: "sync", kind: "gross-margin-refresh", status: "failed", title: "同步当月项目报价", message: "同步失败", error: "企业微信授权已过期，请重新运行 wecom-cli init", progress: 0, createdAt: new Date(now - 3600_000).toISOString(), updatedAt: new Date(now - 3600_000).toISOString() };
  assert.match(getGrossMarginProjectSyncError(failed, source), /暂无可用项目缓存/);
  assert.doesNotMatch(getGrossMarginProjectSyncError(failed, source), /上次成功缓存/);
  assert.match(getGrossMarginProjectSyncError(failed, { ...source, fetchedAt: failed.createdAt }), /当前使用上次成功缓存/);
});

test("按上海年月取当月表、使用第一个账号列并区分平台", () => {
  assert.equal(getGrossMarginProjectMonth(new Date("2026-09-30T16:00:00Z")), "2026-10");
  const orders = parseWecomProjectSheet(fixture, "2026-10");
  assert.equal(orders.length, 3);
  const matches = findGrossMarginProjectOrders(orders, "bilibili", " 薛定谔的机- ");
  assert.deepEqual(matches.map(order => order.projectName), ["凯度微蒸烤箱", "脑花AI NPC"]);
  assert.equal(findGrossMarginProjectOrders(orders, "bilibili", "薛定谔").length, 0);
  assert.equal(findGrossMarginProjectOrders(orders, "douyin", "薛定谔的机").length, 1);
});

test("链接唯一匹配才自动选择，多项目待选择，同名项目保持独立行", () => {
  const matches = findGrossMarginProjectOrders(parseWecomProjectSheet(fixture, "2026-10"), "bilibili", "薛定谔的机");
  assert.equal(chooseGrossMarginProjectOrder(matches, ""), null);
  const chosen = chooseGrossMarginProjectOrder(matches, "https://www.bilibili.com/video/BV1ArWc6qEVK/?other=1");
  assert.equal(chosen?.projectName, "凯度微蒸烤箱");
  assert.deepEqual(getGrossMarginProjectPrices(chosen!), { originalPrice: "12000", rebateRate: "20", discountPrice: "9600" });
  const duplicate = { ...matches[0], id: "other", finalPrice: 9500 };
  assert.equal(chooseGrossMarginProjectOrder([...matches, duplicate], chosen!.videoUrl), null);
  assert.equal(chooseGrossMarginProjectOrder([matches[1]], "")?.id, matches[1].id);
});

test("监控标题使用维护产品项目，分组不冒充产品，旧记录只做明确匹配", () => {
  const orders = parseWecomProjectSheet(fixture, "2026-10");
  const base = { platform: "bilibili", accountName: "薛定谔的机丶", videoUrl: orders[0].videoUrl,
    projectId: "batch-1", projectName: "0831 批量监控 4 条", title: "原视频标题" } as GrossMarginMonitorRecord;
  assert.equal(getGrossMarginMonitorProjectName(base, orders), "凯度微蒸烤箱");
  assert.equal(getGrossMarginMonitorProjectName({ ...base, maintenanceProject: { orderId: "chosen", name: "漫步者耳机" } }, orders), "漫步者耳机");
  const unknown = { ...base, videoUrl: "https://www.bilibili.com/video/BV12Vpt62ERk" };
  assert.equal(getGrossMarginMonitorProjectName(unknown, orders), "");
  assert.equal(getGrossMarginMonitorProjectName(unknown, []), "");
  assert.equal(getGrossMarginMonitorProjectName({ ...unknown, projectId: undefined, projectName: "已保存产品名" }, []), "已保存产品名");
  const single = [{ ...orders[0], videoUrl: "" }];
  assert.equal(getGrossMarginMonitorProjectName(unknown, single), "");
  assert.equal(getGrossMarginMonitorProjectName(unknown, [orders[0]]), "");
  assert.equal(getGrossMarginMonitorProjectName({ ...unknown, platform: "douyin" }, single), "");
});

test("折后金额直接取最终合作价格，缺失/异常金额显式提示且不会编造成零", () => {
  const orders = parseWecomProjectSheet(fixture, "2026-10");
  assert.equal(getGrossMarginProjectPrices(orders[2]).discountPrice, "14000");
  for (const value of ["", "金额待定", "-1", "0x10", "100000001"]) {
    const order = parseWecomProjectSheet(["26.10月", header, separator, `|B站|测试|项目||12000|${value}|9000|||`].join("\n"), "2026-10")[0];
    assert.equal(order.rebateAmount, null);
    assert.equal(getGrossMarginProjectPrices(order).rebateRate, "");
    assert.match(order.warning!, /返点金额/);
  }
  const invalid = { ...orders[0], rebateAmount: 13000 };
  assert.equal(getGrossMarginProjectPrices(invalid).rebateRate, "");
  const zero = { ...orders[0], orderAmount: 0, rebateAmount: 0, finalPrice: 0 };
  assert.deepEqual(getGrossMarginProjectPrices(zero), { originalPrice: "0", rebateRate: "0", discountPrice: "0" });
  assert.throws(() => parseWecomProjectSheet(fixture, "2027-10"), /没有 2027-10 工作表/);
  assert.throws(() => parseWecomProjectSheet("26.10月\n|下单金额|\n|---|", "2026-10"), /缺少/);
});

test("项目同步沿用任务中心契约且不能混入监控刷新", () => {
  assert.ok(startJobSchema.safeParse({ kind: "gross-margin-refresh", input: { syncProjects: true } }).success);
  assert.ok(startJobSchema.safeParse({ kind: "gross-margin-refresh", input: { recordIds: ["record"] } }).success);
  assert.equal(startJobSchema.safeParse({ kind: "gross-margin-refresh", input: { syncProjects: true, recordIds: ["record"] } }).success, false);
});

test("隔离资料库中的项目缓存校验、取消及远端失败保持原有缓存", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gross-project-test-"));
  const envKeys = ["STYLE_LIBRARY_DIR", "WECOM_CLI_BIN", "WECOM_PROJECT_SHEET_URL"] as const;
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    process.env.STYLE_LIBRARY_DIR = dir;
    process.env.WECOM_PROJECT_SHEET_URL = "https://doc.weixin.qq.com/sheet/test";
    const cli = path.join(dir, "fake-wecom");
    process.env.WECOM_CLI_BIN = cli;
    const month = getGrossMarginProjectMonth();
    const content = fixture.replaceAll("26.10月", `${month.slice(2, 4)}.${Number(month.slice(5))}月`);
    const writeCli = (value: unknown) => fs.writeFile(cli, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(value) }] } }))});\n`, { mode: 0o755 });
    assert.deepEqual(await getGrossMarginProjectSource(), { month, orders: [], stale: true });
    await writeCli({ errcode: 0, task_done: true, content });
    await syncGrossMarginProjectSource({ onProgress: async () => {} });
    const cached = await getGrossMarginProjectSource();
    assert.equal(cached.orders.length, 3);
    assert.equal(cached.stale, false);
    const aborted = new AbortController(); aborted.abort(new Error("测试取消"));
    await assert.rejects(syncGrossMarginProjectSource({ signal: aborted.signal, onProgress: async () => {} }), /测试取消/);
    await writeCli({ errcode: 0, task_done: true, content: "没有当月表" });
    await assert.rejects(syncGrossMarginProjectSource({ onProgress: async () => {} }), /没有.*工作表/);
    assert.deepEqual(await getGrossMarginProjectSource(), cached);
    const files = await fs.readdir(path.join(dir, "gross-margin", "project-orders"));
    await fs.writeFile(path.join(dir, "gross-margin", "project-orders", files[0]), "损坏的JSON");
    await assert.rejects(getGrossMarginProjectSource(), /JSON.*损坏/);
  } finally {
    for (const key of envKeys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
