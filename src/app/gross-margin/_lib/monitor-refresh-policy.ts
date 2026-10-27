import type { GrossMarginMonitorRecord } from "@/lib/types";

export const MONITOR_AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const MONITOR_AUTO_REFRESH_TITLE = "每小时自动刷新数据监控";

export function getAutomaticMonitorRefreshRecordIds(
  records: Pick<GrossMarginMonitorRecord, "id" | "lastRefreshedAt" | "createdAt">[],
  now: number,
  lastAutomaticAttemptAt: number
) {
  // 启动失败或任务被取消也保持一小时冷却，避免每分钟重复创建任务。
  if (now - lastAutomaticAttemptAt < MONITOR_AUTO_REFRESH_INTERVAL_MS) return [];
  return records.filter(record => {
    const lastAttempt = Date.parse(record.lastRefreshedAt || record.createdAt);
    return Number.isFinite(lastAttempt) && now - lastAttempt >= MONITOR_AUTO_REFRESH_INTERVAL_MS;
  }).map(record => record.id);
}
