import type { GrossMarginPriceTable } from "./types";

export const grossMarginReviewTemplateVariables = [
  { name: "date", label: "日期" },
  { name: "accountName", label: "账号名" },
  { name: "douyinId", label: "抖音ID" },
  { name: "cooperationCode", label: "合作码" },
  { name: "bilibiliUid", label: "B站 UID" },
  { name: "videoUrl", label: "视频链接" },
  { name: "videoTitle", label: "视频标题" },
  { name: "currentPlayValue", label: "当前播放量" },
  { name: "playLabel", label: "播放类型" },
  { name: "playValue", label: "播放量" },
  { name: "likeLabel", label: "点赞类型" },
  { name: "likeValue", label: "点赞数" },
  { name: "commentLabel", label: "评论类型" },
  { name: "commentValue", label: "评论数" },
  { name: "favoriteValue", label: "收藏数" },
  { name: "shareValue", label: "分享/转发数" },
  { name: "douPlusValue", label: "抖加金额" },
  { name: "mustFireValue", label: "必火金额" },
  { name: "coinValue", label: "投币数" },
  { name: "danmakuValue", label: "弹幕数" },
  { name: "blueLinkLine", label: "蓝链点击行" },
  { name: "maintenanceCost", label: "维护成本" },
  { name: "grossProfit", label: "集团毛利" },
  { name: "grossMarginRate", label: "毛利率" },
  { name: "splitRoundLine", label: "分轮投放行" }
] as const;

export type GrossMarginReviewTemplateVariable = (typeof grossMarginReviewTemplateVariables)[number]["name"];

export type GrossMarginReviewTemplateValues = Partial<Record<GrossMarginReviewTemplateVariable, string | number>>;

const templateVariablePattern = /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g;
// 兼容已保存的旧模板；废弃的审核尾巴只接受解析，不再输出或提供插入按钮。
const supportedTemplateVariables = new Set<string>([...grossMarginReviewTemplateVariables.map((variable) => variable.name), "reviewFooter"]);
const reviewDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "numeric",
  day: "numeric"
});

export function getDefaultGrossMarginReviewTemplate(platform: GrossMarginPriceTable["platform"]) {
  if (platform === "bilibili") {
    return [
      "【B站】",
      "账号：{{accountName}}",
      "视频链接：{{videoUrl}}",
      "视频标题：{{videoTitle}}",
      "当前播放量：{{currentPlayValue}}",
      "播放量（{{playLabel}}）：{{playValue}}",
      "点赞：{{likeValue}}",
      "投币：{{coinValue}}",
      "收藏：{{favoriteValue}}",
      "评论：{{commentValue}}",
      "分享：{{shareValue}}",
      "弹幕：{{danmakuValue}}",
      "必火：{{mustFireValue}}",
      "{{blueLinkLine}}",
      "维护成本：{{maintenanceCost}}元，维护后毛利率{{grossMarginRate}}",
      "集团毛利：{{grossProfit}}元",
      "{{splitRoundLine}}"
    ].join("\n");
  }

  return [
    "【抖音】",
    "账号：{{accountName}}",
    "抖音ID：{{douyinId}}",
    "合作码：{{cooperationCode}}",
    "视频链接：{{videoUrl}}",
    "视频标题：{{videoTitle}}",
    "当前播放量：{{currentPlayValue}}",
    "播放量{{playLabel}}：{{playValue}}",
    "点赞{{likeLabel}}：{{likeValue}}",
    "评论{{commentLabel}}：{{commentValue}}",
    "收藏：{{favoriteValue}}",
    "转发：{{shareValue}}",
    "抖加：{{douPlusValue}}",
    "维护成本预计：{{maintenanceCost}}元，维护后毛利率{{grossMarginRate}}",
    "集团毛利：{{grossProfit}}元",
    "{{splitRoundLine}}"
  ].join("\n");
}

export function normalizeGrossMarginReviewTemplateContent(content: string) {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function findUnknownGrossMarginReviewTemplateVariables(content: string) {
  const unknown = new Set<string>();
  for (const match of content.matchAll(templateVariablePattern)) {
    const name = match[1] as GrossMarginReviewTemplateVariable;
    if (!supportedTemplateVariables.has(name)) unknown.add(match[1]);
  }
  return [...unknown];
}

export function validateGrossMarginReviewTemplate(content: string) {
  const normalized = normalizeGrossMarginReviewTemplateContent(content);
  if (!normalized) throw new Error("文案模板不能为空");

  const unknownVariables = findUnknownGrossMarginReviewTemplateVariables(normalized);
  if (unknownVariables.length) {
    throw new Error(`文案模板包含不支持的变量：${unknownVariables.map((name) => `{{${name}}}`).join("、")}`);
  }

  return normalized;
}

export function renderGrossMarginReviewTemplate(content: string, values: GrossMarginReviewTemplateValues) {
  const normalized = validateGrossMarginReviewTemplate(content);
  const dateParts = reviewDateFormatter.formatToParts(new Date());
  const datePart = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((part) => part.type === type)?.value;
  const currentDate = `${datePart("year")}年${datePart("month")}月${datePart("day")}日`;
  return normalized
    .replace(templateVariablePattern, (_match, name: string) =>
      name === "date" ? currentDate : name === "reviewFooter" ? "" : String(values[name as GrossMarginReviewTemplateVariable] ?? ""))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .join("\n")
    .trim();
}
