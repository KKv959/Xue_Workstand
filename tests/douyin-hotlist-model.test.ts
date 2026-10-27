import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHotlistHref,
  getRefreshJobSettlement,
  getSurgeClass,
  getVisibleHotlistItems,
  parseSortMode
} from "../src/app/douyin-hotlist/_lib/douyin-hotlist-model";
import { buildRefreshLogEntries, buildRefreshLogEntry } from "../src/lib/douyin-hotlist-refresh-log";
import { getDouyinAccessError } from "../src/lib/douyin-access-errors";
import { buildDouyinBatchSessionUrl, buildDouyinUserVideosArgs } from "../src/lib/opencli";
import type { DouyinHotlistItem, DouyinHotlistRefreshJobResult, JobRecord, Platform } from "../src/lib/types";

test("抖音媒体地址查询使用后台一次性 CLI 会话", () => {
  assert.deepEqual(buildDouyinUserVideosArgs("sec_uid", 60), [
    "douyin",
    "user-videos",
    "sec_uid",
    "--limit",
    "20",
    "--with_comments",
    "false",
    "--window",
    "background",
    "--site-session",
    "ephemeral",
    "-f",
    "json"
  ]);
});

test("抖音批量抓取从真实账号页初始化安全签名环境", () => {
  assert.equal(
    buildDouyinBatchSessionUrl("MS4wLjABAAAAa/b"),
    "https://www.douyin.com/user/MS4wLjABAAAAa%2Fb"
  );
});

test("归一化抖音访问错误", () => {
  assert.equal(getDouyinAccessError("Command failed: ArgusSecurityPlugin Uifid Not Found"), "抖音网页会话尚未就绪（Uifid 缺失），请在 Chrome 打开抖音并完成页面验证后重试。");
  assert.equal(getDouyinAccessError("Douyin API error 4 at GET https://www.douyin.com/aweme/v1/web/aweme/post/"), "抖音拒绝访问（403/444），请在 Chrome 打开抖音检查登录或验证状态，稍后再刷新。");
});

test("热榜 URL 只更新自身筛选参数并保留其他查询参数", () => {
  assert.equal(
    buildHotlistHref({
      account: "account-1",
      pathname: "/douyin-hotlist",
      search: "?from=nav&sort=comments",
      sort: "recent",
      window: "24h"
    }),
    "/douyin-hotlist?from=nav&sort=recent&account=account-1&window=24h"
  );

  assert.equal(
    buildHotlistHref({
      account: "all",
      pathname: "/douyin-hotlist",
      search: "?account=old&sort=likes&window=3h",
      sort: "heat",
      window: "3d"
    }),
    "/douyin-hotlist?sort=heat"
  );
});

test("热榜默认按点赞最高，默认排序不写入 URL", () => {
  assert.equal(parseSortMode(null), "likes");
  assert.equal(parseSortMode("unknown"), "likes");
  assert.equal(
    buildHotlistHref({
      account: "all",
      pathname: "/douyin-hotlist",
      search: "?sort=heat",
      sort: "likes",
      window: "3d"
    }),
    "/douyin-hotlist"
  );
});

test("可见热榜按平台过滤后重新排序并生成连续展示名次", () => {
  const items = [
    makeItem({ accountId: "douyin-1", platform: "douyin", likes: 10, heatScore: 500 }),
    makeItem({ accountId: "bilibili-1", platform: "bilibili", likes: 100, heatScore: 300 }),
    makeItem({ accountId: "douyin-2", platform: "douyin", likes: 20, heatScore: 400 })
  ];

  const visible = getVisibleHotlistItems({
    items,
    selectedAccountId: "platform:douyin",
    selectedPlatform: "douyin",
    sortMode: "likes"
  });

  assert.deepEqual(visible.map(({ item, displayRank }) => [item.account.id, displayRank]), [
    ["douyin-2", 1],
    ["douyin-1", 2]
  ]);
  assert.deepEqual(items.map((item) => item.account.id), ["douyin-1", "bilibili-1", "douyin-2"]);
});

test("共享刷新日志使用持久化任务 ID 和服务端完成时间", () => {
  const job = {
    ...makeJob({ status: "failed" }),
    id: "job-hotlist-refresh-shared",
    completedAt: "2026-08-17T10:02:00.000Z",
    error: "抓取超时"
  };
  const log = buildRefreshLogEntry(job);

  assert.equal(log.id, job.id);
  assert.equal(log.at, job.completedAt);
  assert.equal(log.status, "failed");
  assert.equal(log.text, "抓取超时");
});

test("共享刷新日志只保留最近六条已结束热榜任务", () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    ...makeJob({ status: "completed" }),
    id: `job-${index}`,
    updatedAt: `2026-08-17T10:0${index}:00.000Z`
  }));
  jobs.push({
    ...makeJob({ status: "running" }),
    id: "job-running",
    updatedAt: "2026-08-17T10:09:00.000Z"
  });

  const logs = buildRefreshLogEntries(jobs);
  assert.deepEqual(logs.map((log) => log.id), ["job-7", "job-6", "job-5", "job-4", "job-3", "job-2"]);
});

test("刷新任务结算把部分失败转成简短摘要和失败优先的分组明细", () => {
  const result: DouyinHotlistRefreshJobResult = {
    automatic: false,
    refresh: {
      requested: 2,
      completed: 1,
      unchanged: 0,
      failed: 1,
      limit: 10,
      accounts: [
        {
          accountId: "ok",
          name: "账号 A",
          status: "completed",
          changedCount: 3,
          observedCount: 5
        },
        {
          accountId: "failed",
          name: "账号 B",
          status: "failed",
          error: "抓取失败"
        }
      ]
    },
    summary: {
      windowKey: "3d",
      windowLabel: "近 3 天",
      windowDays: 3,
      fromDate: "2026-08-14",
      toDate: "2026-08-17",
      accountCount: 2,
      staleAccountIds: [],
      totalVideoCount: 8,
      recentVideoCount: 8
    }
  };
  const settlement = getRefreshJobSettlement(makeJob({ status: "completed", result }));

  assert.equal(settlement.reload, true);
  assert.equal(settlement.log.status, "warning");
  assert.equal(settlement.log.text, "2 个账号 · 更新 1（3 条） · 失败 1 · 近 3 天");
  assert.deepEqual(settlement.log.groups, [
    { kind: "failed", accounts: ["账号 B"], reason: "抓取失败" }
  ]);
});

test("刷新日志合并相同失败原因并把无变化账号压缩为一组", () => {
  const htmlError = "Command failed: opencli bilibili user-videos 1 -f json\nSyntaxError: Unexpected token '<', <!DOCTYPE is not valid JSON";
  const result: DouyinHotlistRefreshJobResult = {
    automatic: true,
    refresh: {
      requested: 4,
      completed: 0,
      unchanged: 2,
      failed: 2,
      limit: 10,
      accounts: [
        { accountId: "same-a", name: "无变化 A", status: "unchanged" },
        { accountId: "failed-a", name: "失败 A", status: "failed", error: htmlError },
        { accountId: "same-b", name: "无变化 B", status: "unchanged" },
        { accountId: "failed-b", name: "失败 B", status: "failed", error: htmlError }
      ]
    },
    summary: {
      windowKey: "3d",
      windowLabel: "近 3 天",
      windowDays: 3,
      fromDate: "2026-08-14",
      toDate: "2026-08-17",
      accountCount: 4,
      staleAccountIds: [],
      totalVideoCount: 8,
      recentVideoCount: 8
    }
  };

  const settlement = getRefreshJobSettlement(makeJob({ status: "completed", result }));
  assert.deepEqual(settlement.log.groups, [
    { kind: "failed", accounts: ["失败 A", "失败 B"], reason: "B站返回异常页面，数据解析失败" },
    { kind: "unchanged", accounts: ["无变化 A", "无变化 B"] }
  ]);
});

test("自动刷新中断只留下跳过日志", () => {
  const settlement = getRefreshJobSettlement(makeJob({ status: "interrupted", title: "自动刷新视频热榜" }));

  assert.equal(settlement.automatic, true);
  assert.equal(settlement.reload, false);
  assert.equal(settlement.log.status, "skipped");
  assert.match(settlement.log.text, /服务重启中断/);
});

test("飙升标记区分猛涨、上升和普通内容", () => {
  assert.equal(getSurgeClass(undefined), "");
  assert.equal(getSurgeClass(makeSurge("猛涨")), "is-surging surge-rapid");
  assert.equal(getSurgeClass(makeSurge("上升")), "is-surging surge-rising");
});

function makeItem({
  accountId,
  heatScore,
  likes,
  platform
}: {
  accountId: string;
  heatScore: number;
  likes: number;
  platform: Platform;
}): DouyinHotlistItem {
  return {
    rank: 1,
    account: { id: accountId, platform, name: accountId, uid: accountId },
    video: {
      id: `${accountId}-video`,
      platform,
      title: accountId,
      url: `https://example.com/${accountId}`,
      stats: { views: 0, likes, comments: 0, favorites: 0, shares: 0 },
      hotScore: heatScore
    },
    heatScore,
    tags: [],
    signal: ""
  };
}

function makeJob(input: { status: JobRecord["status"]; title?: string; result?: DouyinHotlistRefreshJobResult }): JobRecord {
  return {
    id: "job-1",
    kind: "hotlist-refresh",
    title: input.title || "手动刷新视频热榜",
    status: input.status,
    progress: 100,
    message: "",
    createdAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:00:00.000Z",
    result: input.result
  } as JobRecord;
}

function makeSurge(label: string): NonNullable<DouyinHotlistItem["surge"]> {
  return {
    label,
    reason: "互动速度提升",
    heatDelta: 100,
    heatPerHour: 50,
    intervalHours: 2
  };
}
