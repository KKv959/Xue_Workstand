"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

const ROUTE_BUSY_DELAY_MS = 200;
const ROUTE_INTENT_DELAY_MS = 120;
// 正式服务的页面已预构建，按 Next 默认在可视区预取，点击导航无需再等隧道往返；
// 开发服务仍关闭自动预取，避免首次访问触发全站编译。
export const navPrefetch = process.env.NODE_ENV === "production" ? undefined : false;

/** 导航意图：悬停预热目标页，点击后 200ms 仍未完成才显示进度条。 */
export function useNavIntent(activeHref?: string) {
  const router = useRouter();
  const pathname = usePathname();
  const pendingTimerRef = useRef<number | null>(null);
  const prewarmedRoutesRef = useRef<Set<string>>(new Set());
  const prewarmTimerRef = useRef<number | null>(null);
  const prewarmControllerRef = useRef<AbortController | null>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [showRouteBusy, setShowRouteBusy] = useState(false);

  const clearPending = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    setPendingHref(null);
    setShowRouteBusy(false);
  }, []);

  useEffect(() => {
    clearPending();
  }, [clearPending, pathname]);

  const cancelPrewarm = useCallback(() => {
    if (prewarmTimerRef.current !== null) window.clearTimeout(prewarmTimerRef.current);
    prewarmTimerRef.current = null;
    prewarmControllerRef.current?.abort();
    prewarmControllerRef.current = null;
  }, []);

  const prewarmRoute = useCallback((href: string) => {
    cancelPrewarm();
    if (href === pathname || prewarmedRoutesRef.current.has(href)) return;
    // 只预热用户停留的目标，不在后台遍历全站或触发业务 API。
    prewarmTimerRef.current = window.setTimeout(async () => {
      prewarmTimerRef.current = null;
      if (process.env.NODE_ENV !== "development") {
        prewarmedRoutesRef.current.add(href);
        router.prefetch(href);
        return;
      }
      const controller = new AbortController();
      prewarmControllerRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(href, {
          cache: "no-store", signal: controller.signal,
          headers: { "x-workbench-route-warmup": "1" }
        });
        if (response.ok) prewarmedRoutesRef.current.add(href);
        await response.body?.cancel();
      } catch {
        // 可选预热失败不影响真实导航，后续停留时可以重新尝试。
      } finally {
        window.clearTimeout(timeout);
        if (prewarmControllerRef.current === controller) prewarmControllerRef.current = null;
      }
    }, ROUTE_INTENT_DELAY_MS);
  }, [cancelPrewarm, pathname, router]);

  useEffect(() => () => {
    cancelPrewarm();
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
  }, [cancelPrewarm, pathname]);

  const beginNavigation = useCallback((href: string) => {
    if (href === activeHref || href === pathname) return;
    setPendingHref(href);
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => setShowRouteBusy(true), ROUTE_BUSY_DELAY_MS);
  }, [activeHref, pathname]);

  const handleNavClick = useCallback((event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    cancelPrewarm();
    if (href === activeHref || href === pathname) clearPending();
    else beginNavigation(href);
  }, [activeHref, beginNavigation, cancelPrewarm, clearPending, pathname]);

  /** 绑定到导航链接上的事件集合。 */
  const linkProps = useCallback((href: string) => ({
    onFocus: () => prewarmRoute(href),
    onPointerEnter: () => prewarmRoute(href),
    onPointerLeave: cancelPrewarm,
    onBlur: cancelPrewarm,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => handleNavClick(event, href)
  }), [cancelPrewarm, handleNavClick, prewarmRoute]);

  return { pendingHref, showRouteBusy, beginNavigation, linkProps };
}
