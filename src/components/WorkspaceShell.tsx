"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Search } from "lucide-react";
import { AppNav } from "./AppNav";
import { MobileAppChrome } from "./MobileAppChrome";
import { TaskIsland } from "./TaskIsland";
import { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } from "./CommandPalette";
import { useNavigationVisibility } from "./NavigationPreferences";
import { navPrefetch, useNavIntent } from "./useNavIntent";
import { getActiveSpace, getVisibleSpaces, matchRoute, systemRoutes, type Space } from "./workspace-spaces";
import type { AppMode } from "@/lib/app-mode";

export function WorkspaceShell({ appMode, children }: { appMode: AppMode; children: ReactNode }) {
  const navigation = useNavigationVisibility();
  const visibleSpaces = useMemo(() => getVisibleSpaces(appMode, navigation.hidden), [appMode, navigation.hidden]);
  useSpaceShortcuts(visibleSpaces);

  return (
    <div className="app-shell">
      <AppNav appMode={appMode} navigation={navigation} visibleSpaces={visibleSpaces} />
      <MobileAppChrome appMode={appMode} />
      <div className="workspace-column">
        <WorkspaceTopbar visibleSpaces={visibleSpaces} />
        <main className="main-content" id="main-content">
          {children}
        </main>
      </div>
      <CommandPalette appMode={appMode} spaces={visibleSpaces} />
    </div>
  );
}

function WorkspaceTopbar({ visibleSpaces }: { visibleSpaces: Space[] }) {
  const pathname = usePathname();
  const space = getActiveSpace(pathname, visibleSpaces);
  const route = space ? matchRoute(pathname, space.routes) : matchRoute(pathname, systemRoutes);

  return (
    <header className="topbar">
      <div className="topbar-context">
        {space && space.routes.length > 1 ? (
          <SpaceTabs space={space} activeHref={route?.href} />
        ) : route ? (
          <span className="topbar-title" key={route.href}>{route.title}</span>
        ) : null}
      </div>
      <div className="topbar-tasks">
        <TaskIsland />
      </div>
      <button
        type="button"
        className="topbar-search"
        onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
        aria-label="打开指令面板"
      >
        <Search size={16} strokeWidth={1.9} aria-hidden="true" />
        <span>搜索页面、账号或风格…</span>
        <kbd>⌘K</kbd>
      </button>
    </header>
  );
}

/** 空间内页面切换：白色滑块跟随当前标签，弹簧过渡。 */
function SpaceTabs({ space, activeHref }: { space: Space; activeHref?: string }) {
  const listRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; width: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const { pendingHref, linkProps } = useNavIntent(activeHref);
  const targetHref = pendingHref ?? activeHref;

  useLayoutEffect(() => {
    const list = listRef.current;
    const target = list?.querySelector<HTMLElement>(`[data-href="${targetHref}"]`);
    if (!list || !target) {
      setIndicator(null);
      return;
    }
    setIndicator({ x: target.offsetLeft, width: target.offsetWidth });
  }, [targetHref, space.id]);

  // 首次定位不做动画，避免进入页面时滑块从左侧飞入。
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setAnimate(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <nav className="space-tabs" aria-label={`${space.label}页面`} ref={listRef}>
      {indicator ? (
        <span
          className={`space-tabs-indicator ${animate ? "animate" : ""}`}
          aria-hidden="true"
          style={{ "--tab-x": `${indicator.x}px`, "--tab-w": `${indicator.width}px` } as CSSProperties}
        />
      ) : null}
      {space.routes.map((route) => (
        <Link
          key={route.href}
          href={route.href}
          prefetch={navPrefetch}
          data-href={route.href}
          className={`space-tab ${route.href === targetHref ? "active" : ""}`}
          aria-current={route.href === activeHref ? "page" : undefined}
          {...linkProps(route.href)}
        >
          {route.label}
        </Link>
      ))}
    </nav>
  );
}

/** 不在输入状态时，按 1–4 切换空间。 */
function useSpaceShortcuts(visibleSpaces: Space[]) {
  const router = useRouter();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']")) return;
      const space = visibleSpaces.find((item) => item.shortcut === event.key);
      if (!space) return;
      event.preventDefault();
      // 侧栏会记住空间内上次的页面；快捷键直接点那个链接，复用同一套记忆与进度反馈。
      const link = document.querySelector<HTMLAnchorElement>(`.rail-spaces a[title^="${space.label}"]`);
      if (link) link.click();
      else router.push(space.routes[0].href);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, visibleSpaces]);
}
