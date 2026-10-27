import assert from "node:assert/strict";
import test from "node:test";
import { getAutomaticMonitorRefreshRecordIds, MONITOR_AUTO_REFRESH_INTERVAL_MS } from "../src/app/gross-margin/_lib/monitor-refresh-policy";

const now = Date.parse("2026-10-15T12:00:00+08:00");
const record = (id: string, minutesAgo: number) => ({ id, lastRefreshedAt: new Date(now - minutesAgo * 60_000).toISOString(), createdAt: new Date(now - 24 * 60 * 60_000).toISOString() });

test("满一小时才自动抓取，手动刚刷新过的记录跳过", () => {
  assert.equal(MONITOR_AUTO_REFRESH_INTERVAL_MS, 60 * 60_000);
  assert.deepEqual(getAutomaticMonitorRefreshRecordIds([record("59m", 59), record("60m", 60), record("61m", 61), record("manual", 1)], now, 0), ["60m", "61m"]);
});

test("启动失败、取消与终态后仍有小时冷却，不会每分钟重试", () => {
  assert.deepEqual(getAutomaticMonitorRefreshRecordIds([record("old", 120)], now, now - 59 * 60_000), []);
  assert.deepEqual(getAutomaticMonitorRefreshRecordIds([record("old", 120)], now, now - 60 * 60_000), ["old"]);
});

test("新记录以创建时间为基线，时钟回退不重复抓取", () => {
  const records = [{ id: "new", createdAt: new Date(now - 5 * 60_000).toISOString() }, { id: "due", createdAt: new Date(now - 60 * 60_000).toISOString() }];
  assert.deepEqual(getAutomaticMonitorRefreshRecordIds(records, now, 0), ["due"]);
  assert.deepEqual(getAutomaticMonitorRefreshRecordIds(records, now, now + 1), []);
});
