"use client";

import { useEffect, useState } from "react";
import { getGrossMarginProjectSource } from "@/lib/client";
import type { GrossMarginProjectSource } from "@/lib/types";

export function useGrossMarginProjects(enabled: boolean) {
  const [source, setSource] = useState<GrossMarginProjectSource | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getGrossMarginProjectSource(controller.signal).then(setSource).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取项目报价失败");
    });
    return () => controller.abort();
  }, [enabled]);

  return { source, error, loading: false };
}
