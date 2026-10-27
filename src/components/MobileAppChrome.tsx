"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LibraryBig, Flame, Home, Menu, PenLine, Sword } from "lucide-react";
import { SkinToggle } from "./SkinToggle";
import { TaskCenter } from "./TaskCenter";
import { useRemoteStatus } from "./RemoteStatusProvider";
import type { AppMode } from "@/lib/app-mode";

// 手机底栏与桌面图标栏同一套空间：今天 + 发现 / 素材 / 创作，数据与系统收进“更多”。
const primaryItems = [
  { href: "/mobile", label: "今天", icon: Home, exact: true },
  { href: "/douyin-hotlist", label: "发现", icon: Flame, also: ["/hotspots"] },
  { href: "/library", label: "素材", icon: LibraryBig },
  { href: "/writer", label: "创作", icon: PenLine, also: ["/assets", "/images", "/tools"] },
  { href: "/mobile/more", label: "更多", icon: Menu, more: true }
];

const secondaryPrefixes = ["/gross-margin", "/ai-settings"];

export function MobileAppChrome({ appMode }: { appMode: AppMode }) {
  const pathname = usePathname();
  const remote = useRemoteStatus();
  if (appMode === "gross-margin") return null;

  return (
    <>
      <header className="mobile-top-bar">
        <Link className="mobile-top-brand" href="/mobile">
          <span className="mobile-top-mark" aria-hidden="true">
            <span className="mobile-top-mark-default">风</span>
            <Sword className="mobile-top-mark-shinigami" size={19} strokeWidth={2} />
          </span>
          <span className="mobile-brand-copy mobile-brand-copy-default">
            <strong>风格库</strong>
            <small>私人远程工作台</small>
          </span>
          <span className="mobile-brand-copy mobile-brand-copy-shinigami">
            <strong>BLEACH</strong>
            <small>SOUL SOCIETY</small>
          </span>
        </Link>
        <div className="mobile-top-actions">
          <SkinToggle compact />
          <Link
            className={`remote-status-chip ${remote.connection}`}
            href="/mobile/more#service-status"
            aria-label={`后台状态：${connectionLabel(remote.connection)}`}
          >
            <span aria-hidden="true" />
            {connectionLabel(remote.connection)}
          </Link>
          <TaskCenter variant="mobile" />
        </div>
      </header>
      <nav className="mobile-tab-bar" aria-label="手机主导航">
        {primaryItems.map((item) => {
          const active = isActiveItem(pathname, item);
          const Icon = item.icon;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`mobile-tab-link ${active ? "active" : ""}`}
              href={item.href}
              key={item.href}
            >
              <Icon aria-hidden="true" size={21} strokeWidth={1.75} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function isActiveItem(
  pathname: string,
  item: { href: string; exact?: boolean; more?: boolean; also?: string[] }
) {
  if (item.more) {
    return pathname.startsWith(item.href) || secondaryPrefixes.some((prefix) => pathname.startsWith(prefix));
  }
  if (item.exact) return pathname === item.href;
  return [item.href, ...(item.also ?? [])].some((href) => pathname === href || pathname.startsWith(`${href}/`));
}

function connectionLabel(connection: ReturnType<typeof useRemoteStatus>["connection"]) {
  if (connection === "online") return "在线";
  if (connection === "degraded") return "部分可用";
  if (connection === "offline") return "离线";
  return "检查中";
}
