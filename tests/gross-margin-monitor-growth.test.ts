import assert from "node:assert/strict";
import test from "node:test";
import { formatPlaySampleCoverage, formatSampleDuration, getMonitorPlayGrowth } from "../src/app/gross-margin/_lib/monitor-growth";
import type { GrossMarginMonitorPlaySample } from "../src/lib/types";

const now = Date.parse("2026-10-15T00:20:00+08:00");
const sample = (value: number, capturedAt: string, source: GrossMarginMonitorPlaySample["source"] = "refresh") => ({ value, capturedAt, source });

test("播放增长跨零点延续，按真实间隔展示，未满24小时不外推", () => {
  const growth = getMonitorPlayGrowth([
    sample(100, "2026-10-14T23:30:00+08:00"),
    sample(140, "2026-10-15T00:00:00+08:00"),
    sample(170, "2026-10-15T00:20:00+08:00")
  ], now);
  assert.equal(growth.recent?.delta, 30);
  assert.equal(growth.recent?.durationMs, 20 * 60_000);
  assert.equal(growth.day?.delta, 70);
  assert.equal(growth.day?.durationMs, 50 * 60_000);
  assert.equal(growth.stale, false);
});

test("无采样和单次采样保持待比较，不显示虚假零增长", () => {
  assert.equal(getMonitorPlayGrowth(undefined, now).recent, null);
  const growth = getMonitorPlayGrowth([sample(100, new Date(now).toISOString(), "manual")], now);
  assert.equal(growth.recent, null);
  assert.equal(growth.day, null);
  assert.equal(growth.latest?.source, "manual");
});

test("24小时窗口使用当前时间，旧采样不会变成当前增长", () => {
  const growth = getMonitorPlayGrowth([
    sample(100, "2026-10-13T20:00:00+08:00"),
    sample(200, "2026-10-13T21:00:00+08:00")
  ], now);
  assert.equal(growth.stale, true);
  assert.equal(growth.windowSampleCount, 0);
  assert.equal(growth.day, null);
  assert.equal(growth.recent?.delta, 100);
});

test("排除窗口外基线，不将整段增长误计入近24小时", () => {
  const growth = getMonitorPlayGrowth([
    sample(100, "2026-10-14T00:19:00+08:00"),
    sample(200, "2026-10-14T00:20:00+08:00"),
    sample(250, new Date(now).toISOString())
  ], now);
  assert.equal(growth.day?.delta, 50);
  assert.equal(growth.day?.sampleCount, 2);
});

test("有效采样排序去重，保留回落与无变化，忽略未来和非法采样", () => {
  const growth = getMonitorPlayGrowth([
    sample(90, new Date(now).toISOString(), "manual"),
    sample(100, new Date(now - 600_000).toISOString()),
    sample(95, new Date(now).toISOString(), "manual"),
    sample(500, new Date(now + 60_000).toISOString()),
    sample(-1, new Date(now - 100_000).toISOString()),
    sample(10, "invalid")
  ], now);
  assert.equal(growth.recent?.delta, -5);
  assert.equal(growth.day?.sampleCount, 2);
  assert.equal(growth.latest?.source, "manual");
  assert.equal(getMonitorPlayGrowth([
    sample(100, new Date(now - 600_000).toISOString()), sample(100, new Date(now).toISOString())
  ], now).recent?.delta, 0);
  assert.equal(formatSampleDuration(50_000), "不足1分钟");
  assert.equal(formatSampleDuration(90 * 60_000), "1小时30分钟");
});

test("采样覆盖保留时长与次数，长时段缩成单行，时效与小时抓取一致", () => {
  const growth = getMonitorPlayGrowth([
    sample(100, new Date(now - 461 * 60_000).toISOString()),
    sample(110, new Date(now - 400 * 60_000).toISOString()),
    sample(120, new Date(now - 300 * 60_000).toISOString()),
    sample(130, new Date(now - 100 * 60_000).toISOString()),
    sample(140, new Date(now).toISOString())
  ], now);
  assert.equal(formatPlaySampleCoverage(growth.day!), "实测7h41m · 5次");
  assert.equal(getMonitorPlayGrowth([sample(1, new Date(now - 40 * 60_000).toISOString())], now).stale, false);
  assert.equal(getMonitorPlayGrowth([sample(1, new Date(now - 61 * 60_000).toISOString())], now).stale, true);
});
