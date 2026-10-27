import type {
  DouyinHotlistRefreshAccountResult,
  DouyinHotlistRefreshJobResult,
  JobRecord
} from "./types";
import { getDouyinAccessError, pausedDouyinRefreshError } from "./douyin-access-errors";

export const MAX_DOUYIN_HOTLIST_REFRESH_LOGS = 6;

export type DouyinHotlistRefreshLogStatus = "success" | "warning" | "failed" | "skipped";
export type DouyinHotlistRefreshLogGroupKind = "failed" | "recovered" | "unchanged";

export type DouyinHotlistRefreshLogGroup = {
  kind: DouyinHotlistRefreshLogGroupKind;
  accounts: string[];
  reason?: string;
};

export type DouyinHotlistRefreshLogEntry = {
  id: string;
  at: string;
  automatic: boolean;
  status: DouyinHotlistRefreshLogStatus;
  text: string;
  groups?: DouyinHotlistRefreshLogGroup[];
};

export type DouyinHotlistRefreshLogResponse = {
  logs: DouyinHotlistRefreshLogEntry[];
};

export type RefreshJobSettlement = {
  automatic: boolean;
  reload: boolean;
  log: Omit<DouyinHotlistRefreshLogEntry, "id" | "at">;
};

export function isTerminalRefreshJob(job: JobRecord) {
  return job.kind === "hotlist-refresh" && !["queued", "running"].includes(job.status);
}

export function buildRefreshLogEntries(jobs: JobRecord[]) {
  return jobs
    .filter(isTerminalRefreshJob)
    .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt))
    .slice(0, MAX_DOUYIN_HOTLIST_REFRESH_LOGS)
    .map(buildRefreshLogEntry);
}

export function buildRefreshLogEntry(job: JobRecord): DouyinHotlistRefreshLogEntry {
  const settlement = getRefreshJobSettlement(job);
  return {
    ...settlement.log,
    id: job.id,
    at: job.completedAt || job.updatedAt || job.createdAt
  };
}

export function getRefreshJobSettlement(job: JobRecord): RefreshJobSettlement {
  const result = getRefreshJobResult(job);
  const automatic = result?.automatic ?? job.title.startsWith("自动");

  if (job.status === "completed") {
    if (!result) {
      const message = job.error || "刷新已完成，但任务明细暂未同步。";
      return {
        automatic,
        reload: true,
        log: { automatic, status: job.error ? "warning" : "success", text: message }
      };
    }
    return {
      automatic,
      reload: true,
      log: {
        automatic,
        status: result.refresh.failed ? "warning" : "success",
        text: buildRefreshLogText(result.refresh, result.summary.windowLabel),
        groups: buildRefreshLogGroups(result.refresh.accounts)
      }
    };
  }

  if (job.status === "cancelled" || job.status === "interrupted") {
    const message = job.status === "cancelled" ? "刷新任务已停止。" : "刷新任务因服务重启中断，请重新发起。";
    return {
      automatic,
      reload: false,
      log: { automatic, status: "skipped", text: message }
    };
  }

  const error = job.error || job.message || "视频热榜刷新失败";
  return {
    automatic,
    reload: false,
    log: { automatic, status: "failed", text: compactRefreshError(error) }
  };
}

function getRefreshJobResult(job: JobRecord): DouyinHotlistRefreshJobResult | null {
  if (!job.result || typeof job.result !== "object") return null;
  const result = job.result as Partial<DouyinHotlistRefreshJobResult>;
  if (!result.refresh || !result.summary || typeof result.automatic !== "boolean") return null;
  return result as DouyinHotlistRefreshJobResult;
}

function buildRefreshLogGroups(accounts: DouyinHotlistRefreshAccountResult[]): DouyinHotlistRefreshLogGroup[] {
  const groups: DouyinHotlistRefreshLogGroup[] = [];
  const failedByReason = new Map<string, string[]>();

  accounts.filter((account) => account.status === "failed").forEach((account) => {
    const reason = compactRefreshError(account.error || "未返回可用结果");
    failedByReason.set(reason, [...(failedByReason.get(reason) || []), account.name]);
  });

  failedByReason.forEach((failedAccounts, reason) => {
    groups.push({ kind: "failed", accounts: failedAccounts, reason });
  });

  const recoveredAccounts = accounts
    .filter((account) => account.status === "completed" && account.retried)
    .map((account) => account.name);
  if (recoveredAccounts.length) {
    groups.push({
      kind: "recovered",
      accounts: recoveredAccounts,
      reason: "批量抓取失败后，单账号重试成功"
    });
  }

  const unchangedAccounts = accounts
    .filter((account) => account.status === "unchanged")
    .map((account) => account.name);
  if (unchangedAccounts.length) groups.push({ kind: "unchanged", accounts: unchangedAccounts });

  return groups;
}

function compactRefreshError(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim();
  const accessError = getDouyinAccessError(normalized);
  if (accessError) return normalized.includes("本轮剩余抖音请求已暂停") ? pausedDouyinRefreshError(accessError) : accessError;
  const platform = /opencli bilibili|B站/i.test(normalized) ? "B站" : /opencli douyin|抖音/i.test(normalized) ? "抖音" : "平台";
  if (/Unexpected token.*<|<!DOCTYPE|not valid JSON/i.test(normalized)) {
    return `${platform}返回异常页面，数据解析失败`;
  }
  if (/timed?\s*out|timeout|超时/i.test(normalized)) return "抓取超时";
  if (/热榜关注列表里的账号已经不存在/.test(normalized)) return "账号已不在热榜关注列表中";
  if (/没有返回这个账号的结果/.test(normalized)) return "抓取未返回该账号结果";
  if (/Command failed: opencli bilibili/i.test(normalized)) return "B站数据抓取失败";
  if (/Command failed: opencli douyin/i.test(normalized)) return "抖音数据抓取失败";
  return normalized.slice(0, 80);
}

function buildRefreshLogText(refresh: DouyinHotlistRefreshJobResult["refresh"], windowLabel: string) {
  const handledCount = refresh.completed + refresh.unchanged + refresh.failed;
  const changedVideoCount = refresh.accounts.reduce((sum, account) => sum + (account.changedCount || 0), 0);
  const parts = [handledCount === refresh.requested ? `${handledCount} 个账号` : `已处理 ${handledCount}/${refresh.requested}`];
  if (refresh.completed) parts.push(`更新 ${refresh.completed}${changedVideoCount ? `（${changedVideoCount} 条）` : ""}`);
  if (refresh.unchanged) parts.push(`无变化 ${refresh.unchanged}`);
  if (refresh.failed) parts.push(`失败 ${refresh.failed}`);
  parts.push(windowLabel);
  return parts.join(" · ");
}
