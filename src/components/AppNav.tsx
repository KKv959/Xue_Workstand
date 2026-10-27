"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Command, Cpu, Settings2 } from "lucide-react";
import { ServiceModeControl } from "./ServiceModeControl";
import { NavigationPreferences, type useNavigationVisibility } from "./NavigationPreferences";
import { useRemoteStatus } from "./RemoteStatusProvider";
import { navPrefetch, useNavIntent } from "./useNavIntent";
import { getActiveSpace, getPreferenceItems, matchRoute, type Space } from "./workspace-spaces";
import { OPEN_COMMAND_PALETTE_EVENT } from "./CommandPalette";
import type { AppMode } from "@/lib/app-mode";

const LAST_ROUTE_KEY = "workbench-space-last-route";

export function AppNav({ appMode, navigation, visibleSpaces }: {
  appMode: AppMode;
  navigation: ReturnType<typeof useNavigationVisibility>;
  visibleSpaces: Space[];
}) {
  const pathname = usePathname();
  const grossMarginMode = appMode === "gross-margin";
  const activeSpace = getActiveSpace(pathname, visibleSpaces);
  const activeIndex = activeSpace ? visibleSpaces.findIndex((space) => space.id === activeSpace.id) : -1;
  const lastRoutes = useLastSpaceRoutes(pathname, visibleSpaces);
  const brandHref = grossMarginMode ? "/gross-margin" : "/douyin-hotlist";
  const { pendingHref, showRouteBusy, linkProps } = useNavIntent(activeSpace ? lastRoutes[activeSpace.id] : undefined);

  return (
    <aside className="rail" aria-label="工作空间">
      {showRouteBusy ? <span className="route-progress" aria-hidden="true" /> : null}
      <Link href={brandHref} prefetch={navPrefetch} className="rail-brand" aria-label={grossMarginMode ? "数据维护监控" : "风格库首页"} {...linkProps(brandHref)}>
        <span aria-hidden="true">{grossMarginMode ? "数" : "风"}</span>
      </Link>
      <nav className="rail-spaces" aria-label="主导航" style={{ "--rail-index": activeIndex } as CSSProperties}>
        {activeIndex >= 0 ? <span className="rail-indicator" aria-hidden="true" /> : null}
        {visibleSpaces.map((space) => {
          const href = lastRoutes[space.id] ?? space.routes[0].href;
          const active = space.id === activeSpace?.id;
          const pending = !active && pendingHref !== null && space.routes.some((route) => route.href === pendingHref);
          const Icon = space.icon;
          return (
            <Link
              key={space.id}
              href={href}
              prefetch={navPrefetch}
              className={`rail-link ${active ? "active" : ""} ${pending ? "pending" : ""}`}
              aria-current={active ? "page" : undefined}
              title={`${space.label} · ${space.hint}（${space.shortcut}）`}
              {...linkProps(href)}
            >
              <Icon size={20} strokeWidth={active ? 2.1 : 1.8} aria-hidden="true" />
              <span>{space.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="rail-bottom">
        <ConnectionDot />
        <button
          type="button"
          className="rail-kbd"
          aria-label="打开指令面板（⌘K）"
          title="指令面板"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
        >
          ⌘K
        </button>
        <SystemMenu appMode={appMode} navigation={navigation} aiActive={pathname.startsWith("/ai-settings")} />
      </div>
    </aside>
  );
}

/** 记住每个空间上次停留的页面，回到空间时直接落在那里。 */
function useLastSpaceRoutes(pathname: string, visibleSpaces: Space[]) {
  const [routes, setRoutes] = useState<Partial<Record<Space["id"], string>>>({});

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(LAST_ROUTE_KEY);
      if (raw) setRoutes(JSON.parse(raw));
    } catch {
      // 会话存储不可用时退回每个空间的第一个页面。
    }
  }, []);

  useEffect(() => {
    const space = getActiveSpace(pathname, visibleSpaces);
    const route = space ? matchRoute(pathname, space.routes) : undefined;
    if (!space || !route) return;
    setRoutes((current) => {
      if (current[space.id] === route.href) return current;
      const next = { ...current, [space.id]: route.href };
      try {
        window.sessionStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(next));
      } catch {
        // 记不住上次位置不影响导航。
      }
      return next;
    });
  }, [pathname, visibleSpaces]);

  // 被隐藏的页面不再作为空间入口。
  return Object.fromEntries(Object.entries(routes).filter(([id, href]) =>
    visibleSpaces.some((space) => space.id === id && space.routes.some((route) => route.href === href))
  )) as Partial<Record<Space["id"], string>>;
}

function ConnectionDot() {
  const remote = useRemoteStatus();
  const label = remote.connection === "online" ? "后台在线"
    : remote.connection === "degraded" ? "后台部分可用"
      : remote.connection === "offline" ? "后台离线" : "正在检查后台";
  return (
    <span className={`rail-connection ${remote.connection}`} role="status" aria-label={label} title={label}>
      <span aria-hidden="true" />
    </span>
  );
}

function SystemMenu({ appMode, navigation, aiActive }: {
  appMode: AppMode;
  navigation: ReturnType<typeof useNavigationVisibility>;
  aiActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const grossMarginMode = appMode === "gross-margin";
  const preferenceItems = useMemo(() => getPreferenceItems(appMode), [appMode]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // 弹窗渲染在 body 上，点到弹窗里不算点到菜单外。
      if (rootRef.current?.contains(target) || (target as Element).closest?.(".workbench-modal, [data-react-aria-top-layer]")) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="rail-system" ref={rootRef}>
      <button
        type="button"
        className={`rail-system-trigger ${open || aiActive ? "active" : ""}`}
        aria-expanded={open}
        aria-label="系统设置"
        title="系统设置"
        onClick={() => setOpen((current) => !current)}
      >
        <Settings2 size={19} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {/* 菜单内容保持挂载：服务模式等弹窗是菜单项的子组件，关闭菜单不能把弹窗一起卸掉。 */}
      <div className="rail-system-menu" data-open={open ? "true" : "false"} aria-hidden={!open} inert={!open}>
        <button
          type="button"
          className="rail-system-item"
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
          }}
        >
          <Command size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>指令面板</span>
          <kbd>⌘K</kbd>
        </button>
        {!grossMarginMode && !navigation.hidden.includes("/ai-settings") ? (
          <Link href="/ai-settings" prefetch={navPrefetch} className={`rail-system-item ${aiActive ? "active" : ""}`} onClick={() => setOpen(false)}>
            <Cpu size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>AI 模型配置</span>
          </Link>
        ) : null}
        {!grossMarginMode ? <div className="rail-system-service"><ServiceModeControl /></div> : null}
        <div className="rail-system-preferences">
          <NavigationPreferences items={preferenceItems} hidden={navigation.hidden} error={navigation.error} ready={navigation.ready} onSave={navigation.save} />
        </div>
      </div>
    </div>
  );
}
