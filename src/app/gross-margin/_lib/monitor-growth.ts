import type { GrossMarginMonitorPlaySample } from "@/lib/types";
import { MONITOR_AUTO_REFRESH_INTERVAL_MS } from "./monitor-refresh-policy";

const DAY_MS = 24 * 60 * 60 * 1000;
export const PLAY_SAMPLE_STALE_MS = MONITOR_AUTO_REFRESH_INTERVAL_MS;

export type PlayGrowthRange = {
  delta: number;
  first: GrossMarginMonitorPlaySample;
  latest: GrossMarginMonitorPlaySample;
  durationMs: number;
  sampleCount: number;
};

export function getMonitorPlayGrowth(samples: GrossMarginMonitorPlaySample[] | undefined, now: number) {
  const byTime = new Map<number, GrossMarginMonitorPlaySample>();
  for (const sample of samples || []) {
    const time = Date.parse(sample.capturedAt);
    if (!Number.isFinite(time) || time > now || !Number.isFinite(sample.value) || sample.value < 0) continue;
    byTime.set(time, sample);
  }
  const sorted = [...byTime.values()].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const latest = sorted.at(-1) ?? null;
  const ageMs = latest ? now - Date.parse(latest.capturedAt) : null;
  // 窗口以当前时间为准；不把昨天的采样冒充今日数据，也不推算窗口边界的播放量。
  const inWindow = sorted.filter((sample) => Date.parse(sample.capturedAt) >= now - DAY_MS);
  return {
    latest,
    ageMs,
    stale: ageMs !== null && ageMs > PLAY_SAMPLE_STALE_MS,
    recent: summarizeRange(sorted.slice(-2)),
    day: summarizeRange(inWindow),
    windowSampleCount: inWindow.length
  };
}

function summarizeRange(samples: GrossMarginMonitorPlaySample[]): PlayGrowthRange | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const latest = samples[samples.length - 1];
  return {
    delta: latest.value - first.value,
    first,
    latest,
    durationMs: Date.parse(latest.capturedAt) - Date.parse(first.capturedAt),
    sampleCount: samples.length
  };
}

export function formatSampleDuration(durationMs: number) {
  const minutes = Math.floor(durationMs / 60_000);
  if (minutes < 1) return "不足1分钟";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}小时${remainder ? `${remainder}分钟` : ""}`;
}

export function formatPlaySampleCoverage(range: PlayGrowthRange) {
  const minutes = Math.floor(range.durationMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const duration = minutes < 1 ? "<1m" : `${hours ? `${hours}h` : ""}${remainder ? `${remainder}m` : ""}`;
  return `实测${duration} · ${range.sampleCount}次`;
}
