"use client";

import { useEffect, useRef, useState } from "react";
import { useFeedback } from "@/components/FeedbackProvider";
import { hydrateVideos } from "@/lib/client";
import type { AccountDetail } from "@/lib/types";

type UseBilibiliStatsHydrationInput = {
  refresh: () => Promise<void>;
  reloadSelectedAccountDetail: (options?: { includeStyle?: boolean; force?: boolean }) => Promise<AccountDetail | null>;
  selectedAccount: AccountDetail | null;
};

type HydrationStatus = "hydrating" | "done" | "failed";
type HydrationState = {
  key: string;
  status: HydrationStatus;
};

export function useVideoStatsHydration({
  refresh,
  reloadSelectedAccountDetail,
  selectedAccount
}: UseBilibiliStatsHydrationInput) {
  const { notify } = useFeedback();
  const hydrationByAccountRef = useRef<Record<string, HydrationState>>({});
  const [hydrationRetryVersion, setHydrationRetryVersion] = useState(0);

  useEffect(() => {
    if (!selectedAccount) return;

    const missingStats = selectedAccount.videos
      .filter((video) => !video.statsHydration || video.statsHydration.status !== "complete")
      .slice(0, 10);
    if (!missingStats.length) return;

    const accountId = selectedAccount.id;
    const accountName = selectedAccount.name;
    const hydrationKey = missingStats.map((video) => video.id).join("|");
    const hydrationState = hydrationByAccountRef.current[accountId];
    if (hydrationState?.key === hydrationKey) return;

    let ignore = false;
    hydrationByAccountRef.current = {
      ...hydrationByAccountRef.current,
      [accountId]: { key: hydrationKey, status: "hydrating" }
    };
    hydrateVideos({
      platform: selectedAccount.platform,
      accountId,
      videoIds: missingStats.map((video) => video.id)
    }).then(async (result) => {
      if (ignore) {
        hydrationByAccountRef.current = clearHydrationState(hydrationByAccountRef.current, accountId, hydrationKey);
        return;
      }

      const failedCount = result.failedCount;
      const succeededCount = result.videos.length - failedCount;
      let refreshError: unknown = null;
      if (result.videos.some((video) => video.statsHydration?.status !== "failed")) {
        try {
          await refresh();
          await reloadSelectedAccountDetail({ force: true });
        } catch (err) {
          refreshError = err;
        }
      }

      if (!ignore) {
        if (!failedCount && !refreshError) {
          hydrationByAccountRef.current = {
            ...hydrationByAccountRef.current,
            [accountId]: { key: hydrationKey, status: "done" }
          };
          return;
        }

        hydrationByAccountRef.current = {
          ...hydrationByAccountRef.current,
          [accountId]: { key: hydrationKey, status: "failed" }
        };
        notify({
          tone: succeededCount > 0 ? "warning" : "error",
          title: `${selectedAccount.platform === "bilibili" ? "B站" : "抖音"}统计未完整补全`,
          message: buildHydrationFailureMessage(accountName, succeededCount, failedCount, refreshError),
          durationMs: 10000,
          action: {
            label: "重试",
            onClick: () => {
              hydrationByAccountRef.current = clearHydrationState(hydrationByAccountRef.current, accountId, hydrationKey);
              setHydrationRetryVersion((version) => version + 1);
            }
          }
        });
      }
    }).catch((error) => {
      if (ignore) return;
      hydrationByAccountRef.current = {
        ...hydrationByAccountRef.current,
        [accountId]: { key: hydrationKey, status: "failed" }
      };
      notify({
        tone: "error",
        title: `${selectedAccount.platform === "bilibili" ? "B站" : "抖音"}统计补全失败`,
        message: buildHydrationFailureMessage(accountName, 0, missingStats.length, error),
        durationMs: 10000,
        action: {
          label: "重试",
          onClick: () => {
            hydrationByAccountRef.current = clearHydrationState(hydrationByAccountRef.current, accountId, hydrationKey);
            setHydrationRetryVersion((version) => version + 1);
          }
        }
      });
    });

    return () => {
      ignore = true;
    };
  }, [hydrationRetryVersion, notify, refresh, reloadSelectedAccountDetail, selectedAccount]);
}

function clearHydrationState(
  current: Record<string, HydrationState>,
  accountId: string,
  hydrationKey: string
) {
  if (current[accountId]?.key !== hydrationKey) return current;
  const next = { ...current };
  delete next[accountId];
  return next;
}

function buildHydrationFailureMessage(
  accountName: string,
  succeededCount: number,
  failedCount: number,
  error: unknown
) {
  const reason = error instanceof Error ? error.message : "";
  if (succeededCount > 0 && failedCount === 0) {
    return `「${accountName}」已补全 ${succeededCount} 条，但刷新页面状态失败${reason ? `：${reason}。` : "。"}可稍后重试。`;
  }
  const prefix = succeededCount > 0
    ? `「${accountName}」已补全 ${succeededCount} 条，仍有 ${failedCount} 条未完整补全`
    : `「${accountName}」互动数据未能补全`;
  return `${prefix}${reason ? `：${reason}。` : "。"}可稍后重试。`;
}
