import { BarChart3, Flame, LibraryBig, PenLine, type LucideIcon } from "lucide-react";
import type { AppMode } from "@/lib/app-mode";

export type SpaceId = "discover" | "library" | "create" | "data";

export type SpaceRoute = {
  href: string;
  label: string;
  /** 自定义导航与 ⌘K 里显示的完整名称。 */
  title: string;
};

export type Space = {
  id: SpaceId;
  label: string;
  hint: string;
  icon: LucideIcon;
  shortcut: string;
  routes: SpaceRoute[];
};

export const spaces: Space[] = [
  {
    id: "discover",
    label: "发现",
    hint: "现在什么在火",
    icon: Flame,
    shortcut: "1",
    routes: [
      { href: "/douyin-hotlist", label: "视频热榜", title: "视频热榜" },
      { href: "/hotspots", label: "热点雷达", title: "热点雷达" }
    ]
  },
  {
    id: "library",
    label: "素材",
    hint: "账号、视频、转写与风格卡",
    icon: LibraryBig,
    shortcut: "2",
    routes: [{ href: "/library", label: "账号库", title: "账号库" }]
  },
  {
    id: "create",
    label: "创作",
    hint: "写稿、评论、生图、工具",
    icon: PenLine,
    shortcut: "3",
    routes: [
      { href: "/writer", label: "写稿", title: "对话写作" },
      { href: "/assets", label: "评论", title: "评论生成" },
      { href: "/images", label: "生图", title: "生图工作台" },
      { href: "/tools", label: "工具", title: "工具台" }
    ]
  },
  {
    id: "data",
    label: "数据",
    hint: "毛利监控与维护",
    icon: BarChart3,
    shortcut: "4",
    routes: [
      { href: "/gross-margin/monitor", label: "监控", title: "数据监控" },
      { href: "/gross-margin", label: "维护", title: "数据维护" }
    ]
  }
];

export const systemRoutes: SpaceRoute[] = [{ href: "/ai-settings", label: "AI 模型配置", title: "AI 模型配置" }];

export function getVisibleSpaces(appMode: AppMode, hidden: string[]) {
  const source = appMode === "gross-margin" ? spaces.filter((space) => space.id === "data") : spaces;
  return source
    .map((space) => ({ ...space, routes: space.routes.filter((route) => !hidden.includes(route.href)) }))
    .filter((space) => space.routes.length);
}

/** 最长前缀匹配，保证 /gross-margin/monitor 不被 /gross-margin 抢走。 */
export function matchRoute(pathname: string, routes: SpaceRoute[]) {
  return routes
    .filter((route) => pathname === route.href || pathname.startsWith(`${route.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0];
}

export function getActiveSpace(pathname: string, visibleSpaces: Space[]) {
  const route = matchRoute(pathname, visibleSpaces.flatMap((space) => space.routes));
  if (!route) return null;
  return visibleSpaces.find((space) => space.routes.includes(route)) ?? null;
}

/** 导航偏好沿用旧的 { href, label, group } 结构，存储格式不变。 */
export function getPreferenceItems(appMode: AppMode) {
  const source = appMode === "gross-margin" ? spaces.filter((space) => space.id === "data") : spaces;
  const items = source.flatMap((space) => space.routes.map((route) => ({ href: route.href, label: route.title, group: space.label })));
  return appMode === "gross-margin" ? items : [...items, ...systemRoutes.map((route) => ({ href: route.href, label: route.title, group: "系统" }))];
}
