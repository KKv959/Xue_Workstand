"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { WriteStyleReferenceInput } from "@/lib/types";

type SessionInput = {
  styleRefs: WriteStyleReferenceInput[];
  prompt: string;
  sourceText: string;
  useWebResearch: boolean;
  revisionInstruction: string;
  revisionMode: "edit" | "recalibrate";
};

export function useWriterSessionSave(key: string, enabled: boolean, input: SessionInput, onError: (message: string) => void) {
  const pending = useRef<SessionInput | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef<() => void>(() => {});
  const { styleRefs, prompt, sourceText, useWebResearch, revisionInstruction, revisionMode } = input;

  useLayoutEffect(() => {
    flush.current = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (!pending.current) return;
      try {
        window.sessionStorage.setItem(key, JSON.stringify(pending.current));
        pending.current = null;
      } catch {
        onError("输入暂存失败：浏览器存储不可用或空间不足，请复制当前输入后再离开页面。");
      }
    };
  }, [key, onError]);

  useLayoutEffect(() => {
    if (!enabled) return;
    pending.current = { styleRefs, prompt, sourceText, useWebResearch, revisionInstruction, revisionMode };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), 300);
  }, [enabled, styleRefs, prompt, sourceText, useWebResearch, revisionInstruction, revisionMode]);

  useEffect(() => {
    const save = () => flush.current();
    const onVisibility = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
