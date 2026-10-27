import type { HotspotEvent, HotspotSignal } from "@/lib/types";
export const radarCategories = [
  { id: "esports", label: "赛事电竞" }, { id: "operations", label: "突发运营" },
  { id: "official", label: "官方动态" }, { id: "breakout", label: "破圈话题" }
];
export type RadarItem = HotspotEvent | HotspotSignal;
export function isTopic(item: RadarItem): item is HotspotEvent { return "monitorType" in item; }
export function radarSource(item: RadarItem) { return isTopic(item) ? item.displayInfo.sourceLine : item.sourceName; }
export function radarDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未更新";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
