"use client";

import { useEffect, useRef, useState } from "react";

const DURATION_MS = 640;

/** 数字变化时从旧值滚到新值；首次渲染直接显示，减少动态效果时不滚动。 */
export function AnimatedNumber({ value, format = (next) => String(Math.round(next)) }: {
  value: number;
  format?: (value: number) => string;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 4);
      const next = from + (value - from) * eased;
      fromRef.current = next;
      setDisplay(next);
      if (progress < 1) frameRef.current = window.requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [value]);

  return <>{format(display)}</>;
}
