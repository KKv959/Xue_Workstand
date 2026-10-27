"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, CornerDownLeft, LibraryBig, PenLine, Search, Settings2 } from "lucide-react";
import { ModalBackdrop } from "./ModalBackdrop";
import { useLibrary } from "./LibraryProvider";
import { systemRoutes, type Space } from "./workspace-spaces";
import type { AppMode } from "@/lib/app-mode";

export const OPEN_COMMAND_PALETTE_EVENT = "workbench:open-command-palette";

type PaletteItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords: string;
  href: string;
  icon: typeof Search;
};

const MAX_ACCOUNT_RESULTS = 6;

export function CommandPalette({ appMode, spaces }: { appMode: AppMode; spaces: Space[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return <PaletteDialog appMode={appMode} spaces={spaces} onClose={() => setOpen(false)} />;
}

function PaletteDialog({ appMode, spaces, onClose }: { appMode: AppMode; spaces: Space[]; onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const { library, loading, error, refresh } = useLibrary();
  const accountsEnabled = appMode !== "gross-margin";
  const requestedRef = useRef(false);

  // 账号只在第一次打开面板时按需读取，已有缓存时不再请求。
  useEffect(() => {
    if (!accountsEnabled || library || requestedRef.current) return;
    requestedRef.current = true;
    void refresh({ force: true });
  }, [accountsEnabled, library, refresh]);

  const items = useMemo(() => {
    const routeItems: PaletteItem[] = spaces.flatMap((space) => space.routes.map((route) => ({
      id: `route:${route.href}`,
      group: "跳转",
      label: route.title,
      hint: space.label,
      keywords: `${route.title} ${route.label} ${space.label} ${route.href}`,
      href: route.href,
      icon: space.icon
    })));
    if (accountsEnabled) {
      routeItems.push(...systemRoutes.map((route) => ({
        id: `route:${route.href}`, group: "跳转", label: route.title, hint: "系统",
        keywords: `${route.title} 模型 设置 ai`, href: route.href, icon: Settings2
      })));
    }
    const needle = query.trim().toLowerCase();
    const matchedRoutes = needle ? routeItems.filter((item) => item.keywords.toLowerCase().includes(needle)) : routeItems;
    if (!accountsEnabled || !library || !needle) return matchedRoutes;
    const accounts = library.accounts.filter((account) => account.name.toLowerCase().includes(needle)).slice(0, MAX_ACCOUNT_RESULTS);
    const accountItems: PaletteItem[] = accounts.flatMap((account) => [
      {
        id: `write:${account.id}`, group: "用它的风格写", label: `用「${account.name}」的风格写`,
        hint: account.styleStatus === "not_generated" ? "风格卡未生成" : "写稿",
        keywords: account.name, href: `/writer?${new URLSearchParams({ accountId: account.id })}`, icon: PenLine
      },
      {
        id: `account:${account.id}`, group: "账号", label: account.name,
        hint: `${account.videoCount} 条视频 · ${account.transcriptCount} 篇文稿`,
        keywords: account.name, href: `/library?${new URLSearchParams({ account: account.id })}`, icon: LibraryBig
      }
    ]);
    return [...matchedRoutes, ...accountItems.filter((item) => item.group === "用它的风格写"), ...accountItems.filter((item) => item.group === "账号")];
  }, [accountsEnabled, library, query, spaces]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    router.push(item.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(items.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(items[activeIndex]);
    }
  };

  let lastGroup = "";
  return (
    <ModalBackdrop backdropClassName="palette-backdrop" className="palette" aria-label="指令面板" initialFocusRef={inputRef} onClose={onClose}>
      <label className="palette-search">
        <Search size={18} strokeWidth={1.9} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={accountsEnabled ? "跳转页面，或输入账号名用它的风格写…" : "跳转页面…"}
          aria-label="搜索页面与账号"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={items[activeIndex] ? `palette-${activeIndex}` : undefined}
        />
        <kbd>Esc</kbd>
      </label>
      <div className="palette-results" id="palette-results" role="listbox" ref={listRef} aria-label="结果">
        {items.map((item, index) => {
          const showGroup = item.group !== lastGroup;
          lastGroup = item.group;
          const Icon = item.icon;
          return (
            <div key={item.id} className="palette-row-wrap" style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}>
              {showGroup ? <div className="palette-group">{item.group}</div> : null}
              <div
                id={`palette-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                className={`palette-row ${index === activeIndex ? "active" : ""}`}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => run(item)}
              >
                <span className="palette-row-icon" aria-hidden="true"><Icon size={16} strokeWidth={1.9} /></span>
                <span className="palette-row-label">{item.label}</span>
                {item.hint ? <span className="palette-row-hint">{item.hint}</span> : null}
                <span className="palette-row-go" aria-hidden="true">{index === activeIndex ? <CornerDownLeft size={14} /> : <ArrowRight size={14} />}</span>
              </div>
            </div>
          );
        })}
        {!items.length ? <p className="palette-empty">没有匹配的页面{accountsEnabled ? "或账号" : ""}，换个关键词试试。</p> : null}
      </div>
      <footer className="palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>1</kbd>–<kbd>4</kbd> 切换空间</span>
        {accountsEnabled ? <span className="palette-footer-status">{error ? `账号读取失败：${error}` : loading && !library ? "正在载入账号…" : library ? `${library.accounts.length} 个账号可搜` : ""}</span> : null}
      </footer>
    </ModalBackdrop>
  );
}
