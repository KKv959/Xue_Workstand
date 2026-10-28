"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  ImagePlus,
  Activity,
  Calculator,
  LibraryBig,
  Flame,
  Layers2,
  MessageSquarePlus,
  PenLine,
  Radar,
  Sword,
  Wrench,
  Settings2
} from "lucide-react";
import { TaskCenter } from "./TaskCenter";
import { SkinToggle } from "./SkinToggle";
import { ServiceModeControl } from "./ServiceModeControl";
import { NavigationPreferences, useNavigationVisibility } from "./NavigationPreferences";
import type { AppMode } from "@/lib/app-mode";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Activity;
  group: "内容发现" | "创作工作区" | "数据与工具";
};

const navItems: NavItem[] = [
  { href: "/images", label: "生图工作台", icon: ImagePlus, group: "数据与工具" },
  { href: "/hotspots", label: "热点雷达", icon: Radar, group: "内容发现" },
  { href: "/douyin-hotlist", label: "视频热榜", icon: Flame, group: "内容发现" },
  { href: "/library", label: "账号库", icon: LibraryBig, group: "创作工作区" },
  { href: "/writer", label: "对话写作", icon: PenLine, group: "创作工作区" },
  { href: "/assets", label: "评论生成", icon: MessageSquarePlus, group: "创作工作区" },
  { href: "/tools", label: "工具台", icon: Wrench, group: "数据与工具" },
  { href: "/ai-settings", label: "AI 模型配置", icon: Settings2, group: "数据与工具" },
  { href: "/gross-margin", label: "数据维护", icon: Calculator, group: "数据与工具" },
  { href: "/gross-margin/monitor", label: "数据监控", icon: Activity, group: "数据与工具" },
];

const navGroupOrder: NavItem["group"][] = ["内容发现", "创作工作区", "数据与工具"];
const navGroupCodes: Record<NavItem["group"], string> = {
  "内容发现": "壱 · RECON",
  "创作工作区": "弐 · CREATION",
  "数据与工具": "参 · ARSENAL"
};

const grossMarginNavItems = navItems.filter((item) => item.href.startsWith("/gross-margin"));
const ROUTE_BUSY_DELAY_MS = 200;
const ROUTE_INTENT_DELAY_MS = 180;
// 按悬停、聚焦或触摸意图预取目标，避免争抢首屏带宽。
const navPrefetch = false;

export function AppNav({ appMode }: { appMode: AppMode }) {
  const router = useRouter();
  const pathname = usePathname();
  const pendingTimerRef = useRef<number | null>(null);
  const prewarmedRoutesRef = useRef<Set<string>>(new Set());
  const prewarmTimerRef = useRef<number | null>(null);
  const prewarmControllerRef = useRef<AbortController | null>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [showRouteBusy, setShowRouteBusy] = useState(false);
  const grossMarginMode = appMode === "gross-margin";
  const navigation = useNavigationVisibility();
  const visibleNavItems = useMemo(() => grossMarginMode ? grossMarginNavItems : navItems, [grossMarginMode]);
  const visibleNavGroups = useMemo(() => navGroupOrder
    .map((label) => ({ label, items: visibleNavItems.filter((item) => item.group === label && item.href !== "/ai-settings" && !navigation.hidden.includes(item.href)) }))
    .filter((group) => group.items.length), [visibleNavItems, navigation.hidden]);
  const brandHref = grossMarginMode ? "/gross-margin" : "/douyin-hotlist";
  const activeHref = visibleNavItems
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;

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
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
    }
    pendingTimerRef.current = window.setTimeout(() => {
      setShowRouteBusy(true);
    }, ROUTE_BUSY_DELAY_MS);
  }, [activeHref, pathname]);

  const handleNavClick = useCallback((event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    cancelPrewarm();
    if (href === activeHref || href === pathname) clearPending();
    else beginNavigation(href);
  }, [activeHref, beginNavigation, cancelPrewarm, clearPending, pathname]);

  return (
    <aside className="sidebar">
      {showRouteBusy ? <span className="route-progress" aria-hidden="true" /> : null}
      <Link
        href={brandHref}
        prefetch={navPrefetch}
        className="brand"
        onFocus={() => void prewarmRoute(brandHref)}
        onTouchStart={() => void prewarmRoute(brandHref)}
        onClick={(event) => handleNavClick(event, brandHref)}
        onPointerLeave={cancelPrewarm}
        onBlur={cancelPrewarm}
        onPointerEnter={() => void prewarmRoute(brandHref)}
      >
        <span className="brand-mark" aria-hidden="true">
          <Layers2 className="brand-mark-default" size={23} strokeWidth={1.8} />
          <Sword className="brand-mark-shinigami" size={20} strokeWidth={1.9} />
        </span>
        <span className="brand-copy brand-copy-default">
          <strong>{grossMarginMode ? "数据维护监控" : "风格库"}</strong>
          <small>{grossMarginMode ? "Windows 便携版" : "创作工作台"}</small>
        </span>
        <span className="brand-copy brand-copy-shinigami">
          <strong>BLEACH</strong>
          <small>死神 · SOUL SOCIETY</small>
        </span>
      </Link>
      <nav className="nav-list" aria-label="主导航">
        <NavigationPreferences items={visibleNavItems} hidden={navigation.hidden} error={navigation.error} ready={navigation.ready} onSave={navigation.save} />
        {visibleNavGroups.map((group) => {
          return (
            <section className="nav-section" key={group.label} aria-labelledby={`nav-${group.label}`}>
              <h2 className="nav-section-label" id={`nav-${group.label}`}>
                <span>{group.label}</span>
                <small className="nav-section-code" aria-hidden="true">{navGroupCodes[group.label]}</small>
              </h2>
              <div className="nav-section-items">
                {group.items.map((item) => {
                  const active = item.href === activeHref;
                  const pending = item.href === pendingHref && !active;
                  const Icon = item.icon;
                  return (
                    <div className="nav-group" key={item.href}>
                      <Link
                        href={item.href}
                        prefetch={navPrefetch}
                        className={`nav-link ${active ? "active" : ""} ${pending ? "pending" : ""}`}
                        aria-current={active ? "page" : undefined}
                        onFocus={() => void prewarmRoute(item.href)}
        onTouchStart={() => void prewarmRoute(item.href)}
                        onClick={(event) => handleNavClick(event, item.href)}
                        onPointerLeave={cancelPrewarm}
                        onBlur={cancelPrewarm}
                        onPointerEnter={() => void prewarmRoute(item.href)}
                      >
                        <span className="nav-emoji" aria-hidden="true">
                          <Icon size={18} strokeWidth={1.75} />
                        </span>
                        <span>{item.label}</span>
                        <span className="nav-soul-mark" aria-hidden="true">魂</span>
                      </Link>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        <SkinToggle />
        <TaskCenter />
        {!grossMarginMode ? <ServiceModeControl /> : null}
        {!grossMarginMode && !navigation.hidden.includes("/ai-settings") ? (
          <Link
            href="/ai-settings"
            prefetch={navPrefetch}
            className={`btn ghost nav-link sidebar-settings ${activeHref === "/ai-settings" ? "active" : ""} ${pendingHref === "/ai-settings" && activeHref !== "/ai-settings" ? "pending" : ""}`}
            style={{ width: "100%", justifyContent: "flex-start" }}
            aria-current={activeHref === "/ai-settings" ? "page" : undefined}
            onFocus={() => void prewarmRoute("/ai-settings")}
        onTouchStart={() => void prewarmRoute("/ai-settings")}
            onClick={(event) => handleNavClick(event, "/ai-settings")}
            onPointerLeave={cancelPrewarm}
            onBlur={cancelPrewarm}
            onPointerEnter={() => void prewarmRoute("/ai-settings")}
          >
            <Settings2 size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>AI 模型配置</span>
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
