import type { CollectOrder, Platform } from "@/lib/types";

export type TimeRange = "all" | "7d" | "30d" | "90d" | "180d" | "365d" | "3y" | "custom";

export const collectOrderOptions: Record<Platform, Array<{ value: CollectOrder; label: string }>> = {
  bilibili: [
    { value: "views", label: "播放优先" },
    { value: "likes", label: "点赞优先" },
    { value: "favorites", label: "收藏优先" },
    { value: "comments", label: "评论优先" },
    { value: "pubdate", label: "时间优先" }
  ],
  douyin: [
    { value: "likes", label: "点赞优先" },
    { value: "comments", label: "评论优先" },
    { value: "pubdate", label: "时间优先" }
  ]
};

export function normalizeCollectOrder(platform: Platform, order: CollectOrder): CollectOrder {
  const options = collectOrderOptions[platform];
  return options.some((option) => option.value === order) ? order : options[0].value;
}

export const timeRangeOptions: Array<{ value: TimeRange; label: string; days?: number }> = [
  { value: "all", label: "不限" },
  { value: "7d", label: "近 7 天", days: 7 },
  { value: "30d", label: "近 30 天", days: 30 },
  { value: "90d", label: "近 90 天", days: 90 },
  { value: "180d", label: "近半年", days: 180 },
  { value: "365d", label: "近一年", days: 365 },
  { value: "3y", label: "近 3 年", days: 365 * 3 },
  { value: "custom", label: "自定义" }
];

export function getDateFilter(timeRange: TimeRange, customFromDate: string, customToDate: string) {
  if (timeRange === "all") return {};
  if (timeRange === "custom") {
    return {
      ...(customFromDate ? { fromDate: customFromDate } : {}),
      ...(customToDate ? { toDate: customToDate } : {})
    };
  }

  const option = timeRangeOptions.find((item) => item.value === timeRange);
  if (!option?.days) return {};

  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - option.days + 1);

  return {
    fromDate: toDateInputValue(from),
    toDate: toDateInputValue(today)
  };
}

export function formatTimeRangeLabel(timeRange: TimeRange, fromDate?: string, toDate?: string) {
  const option = timeRangeOptions.find((item) => item.value === timeRange);
  if (timeRange !== "custom") return option?.label || "不限";
  if (fromDate && toDate) return `${fromDate} 至 ${toDate}`;
  if (fromDate) return `${fromDate} 之后`;
  if (toDate) return `${toDate} 之前`;
  return "自定义不限";
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
