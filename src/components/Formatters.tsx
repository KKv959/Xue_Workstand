export function formatPlatform(platform: string) {
  return platform === "bilibili" ? "B站" : "抖音";
}

export function formatNumber(value: number) {
  if (!value) return "0";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatDate(value?: string) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(+date)) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatDateWithYear(value?: string) {
  if (!value) return "暂无";

  const dateOnly = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return `${year}/${month.padStart(2, "0")}/${day.padStart(2, "0")}`;
  }

  const date = new Date(value);
  if (Number.isNaN(+date)) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
