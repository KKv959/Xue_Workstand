"use client";

import { useEffect, type Dispatch, type SetStateAction } from "react";
import { useFeedback } from "@/components/FeedbackProvider";
import { getGrossMarginLibrary } from "@/lib/client";
import type { GrossMarginLibrary } from "@/lib/types";

export function useGrossMarginAccountRefresh(
  library: GrossMarginLibrary | null,
  setLibrary: Dispatch<SetStateAction<GrossMarginLibrary | null>>
) {
  const { notify } = useFeedback();
  useEffect(() => {
    if (!library?.accountSourceRefreshing) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      void getGrossMarginLibrary({ revalidate: true }).then(result => {
        if (!stopped) setLibrary(result);
      }).catch(error => {
        if (!stopped) {
          setLibrary(current => current ? { ...current, accountSourceRefreshing: false } : current);
          notify({ tone: "error", message: error instanceof Error ? error.message : "在线账号缓存状态读取失败" });
        }
      });
    }, 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [library, notify, setLibrary]);
}
