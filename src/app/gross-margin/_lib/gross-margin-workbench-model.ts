import { getGrossMarginAccountDisplayName, normalizeGrossMarginAccountName } from "@/lib/gross-margin-account-names";
import {
  parseGrossMarginMetric,
  formatThreshold,
  getAbsoluteServiceQuantity,
  getActiveServiceOptions,
  getSelectedOption,
  getSplitRoundStep,
  makeDefaultSelections,
  makeEmptyQuantityInputs,
  makePriceInputs,
  roundUpToStep,
  toAbsoluteMetricValue
} from "@/lib/gross-margin-calculator";
import {
  getDefaultGrossMarginReviewTemplate,
  type GrossMarginReviewTemplateValues
} from "@/lib/gross-margin-template";
import type {
  GrossMarginAccountPrice,
  GrossMarginCalculationLine,
  GrossMarginCalculationResult,
  GrossMarginLibrary,
  GrossMarginPriceOption,
  GrossMarginPriceTable,
  GrossMarginReviewTemplate,
  GrossMarginServiceKind
} from "@/lib/types";

export type PlatformKey = GrossMarginPriceTable["platform"];
export type AccountPriceKind = "custom" | "implant";

export type GrossMarginImportedMetric = {
  service: GrossMarginServiceKind;
  label: string;
  optionHint: string;
  rawValue: string;
};

export type GrossMarginImportedTemplate = {
  platform: PlatformKey;
  accountName: string;
  videoUrl: string;
  metrics: GrossMarginImportedMetric[];
};

export type EngagementTarget = {
  commentCount: number;
  danmakuCount: number;
  href: string;
};

export const PLATFORM_OPTIONS: Array<{ value: PlatformKey; label: string }> = [
  { value: "douyin", label: "抖音" },
  { value: "bilibili", label: "B站" }
];

export function getPlatformReviewTemplate(
  library: GrossMarginLibrary | null,
  platform: PlatformKey
): GrossMarginReviewTemplate {
  const defaultContent = getDefaultGrossMarginReviewTemplate(platform);
  return (
    library?.templates.find((template) => template.platform === platform) || {
      platform,
      content: defaultContent,
      defaultContent,
      customized: false,
      updatedAt: ""
    }
  );
}

export function normalizeTemplateText(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

export function countTemplateLines(value: string) {
  return value.split("\n").filter((line) => line.trim()).length;
}

export function buildImportedMaintenanceState({
  accountName,
  accounts,
  currentPlatform,
  currentPriceInputs,
  currentTable,
  currentVideoUrl,
  tables,
  template
}: {
  accountName: string;
  accounts: GrossMarginAccountPrice[];
  currentPlatform: PlatformKey;
  currentPriceInputs: Record<string, string>;
  currentTable: GrossMarginPriceTable | null;
  currentVideoUrl: string;
  tables: GrossMarginPriceTable[];
  template: GrossMarginImportedTemplate;
}) {
  const platform = template.platform || currentPlatform;
  const table = tables.find((item) => item.platform === platform) || currentTable;
  const selectedOptions: Partial<Record<GrossMarginServiceKind, string>> = table
    ? { ...makeDefaultSelections(table) }
    : {};
  const quantityInputs = makeEmptyQuantityInputs();

  if (table) {
    for (const metric of template.metrics) {
      const options = getActiveServiceOptions(table, metric.service);
      const option = findImportedOption(options, metric);
      if (option) selectedOptions[metric.service] = option.id;
      const selectedOption = option || getSelectedOption(options, selectedOptions[metric.service]);
      if (selectedOption) {
        quantityInputs[metric.service] = formatImportedQuantity(metric.rawValue, selectedOption.quantityUnit);
      }
    }
  }

  const nextAccountName = getGrossMarginAccountDisplayName(template.accountName || accountName);
  const platformAccounts = accounts.filter((account) => account.platform === platform);

  return {
    accountName: nextAccountName,
    matchedAccount: findGrossMarginAccount(platformAccounts, nextAccountName),
    platform,
    priceInputs: table ? makePriceInputs(table) : currentPriceInputs,
    quantityInputs,
    selectedOptions,
    table,
    videoUrl: template.videoUrl || currentVideoUrl
  };
}

export function findGrossMarginAccount(accounts: GrossMarginAccountPrice[], rawName: string) {
  const name = normalizeGrossMarginAccountName(rawName);
  if (!name) return null;
  return (
    accounts.find((account) => normalizeGrossMarginAccountName(account.name) === name) ||
    accounts.find((account) => {
      const candidate = normalizeGrossMarginAccountName(account.name);
      return candidate && (candidate.includes(name) || name.includes(candidate));
    }) ||
    null
  );
}

export function getGrossMarginAccountPrice(
  account: GrossMarginAccountPrice,
  kind: AccountPriceKind
) {
  if (kind === "implant" && account.secondaryPrice !== undefined) {
    return {
      kind,
      label: "植入报价",
      value: account.secondaryPrice
    };
  }
  return {
    kind: "custom" as const,
    label: "定制报价",
    value: account.defaultPrice
  };
}

export function buildGrossMarginTemplateValues({
  account,
  accountName,
  calculation,
  currentPlayCount,
  platform,
  splitDeliveryEnabled,
  videoTitle = "",
  videoUrl
}: {
  account: GrossMarginAccountPrice | null;
  accountName: string;
  calculation: GrossMarginCalculationResult;
  currentPlayCount?: number | null;
  platform: PlatformKey;
  splitDeliveryEnabled: boolean;
  videoTitle?: string;
  videoUrl: string;
}): GrossMarginReviewTemplateValues {
  const lines = new Map(calculation.lines.map((line) => [line.service, line]));
  const displayName = getGrossMarginAccountDisplayName(account?.name || accountName);
  const displayVideoUrl = videoUrl.trim();
  const splitRoundLine = splitDeliveryEnabled ? buildSplitRoundLine(lines, platform) : "";
  const playLine = lines.get("play");
  const likeLine = lines.get("like");
  const commentLine = lines.get("comment");
  const favoriteLine = lines.get("favorite");
  const shareLine = lines.get("share");
  const douPlusLine = lines.get("douPlus");
  const mustFireLine = lines.get("mustFire");
  const coinLine = lines.get("coin");
  const danmakuLine = lines.get("danmaku");
  const blueLinkLine = lines.get("blueLink");

  return {
    accountName: displayName,
    douyinId: account?.douyinId || "",
    cooperationCode: account?.cooperationCode || "",
    bilibiliUid: account?.bilibiliUid || "",
    videoUrl: displayVideoUrl,
    videoTitle: videoTitle.trim(),
    currentPlayValue: typeof currentPlayCount === "number" && Number.isFinite(currentPlayCount) && currentPlayCount >= 0
      ? String(currentPlayCount)
      : "未获取",
    playLabel: platform === "bilibili" ? formatBilibiliPlayChannel(playLine) : formatReviewLabelSuffix(playLine),
    playValue: formatReviewMetricValue(playLine, platform),
    likeLabel: formatReviewLabelSuffix(likeLine),
    likeValue: formatReviewMetricValue(likeLine, platform),
    commentLabel: formatReviewLabelSuffix(commentLine),
    commentValue: formatReviewMetricValue(commentLine, platform),
    favoriteValue: formatReviewMetricValue(favoriteLine, platform),
    shareValue: formatReviewMetricValue(shareLine, platform),
    douPlusValue: formatReviewMetricValue(douPlusLine, platform),
    mustFireValue: formatReviewMetricValue(mustFireLine, platform),
    coinValue: formatReviewMetricValue(coinLine, platform),
    danmakuValue: formatReviewMetricValue(danmakuLine, platform),
    blueLinkLine: blueLinkLine && blueLinkLine.quantity > 0
      ? `蓝链点击：${formatReviewMetricValue(blueLinkLine, platform)}`
      : "",
    maintenanceCost: formatReviewMoney(calculation.maintenanceCost),
    grossProfit: formatReviewMoney(calculation.grossProfit),
    grossMarginRate: formatReviewPercent(calculation.grossMarginRate),
    splitRoundLine
  };
}

export function buildEngagementTarget(lines: GrossMarginCalculationLine[], videoUrl: string): EngagementTarget {
  const params = new URLSearchParams();
  const commentCount = getAbsoluteServiceQuantity(lines, "comment");
  const danmakuCount = getAbsoluteServiceQuantity(lines, "danmaku");
  const source = videoUrl.trim();

  if (source) params.set("source", source);
  if (commentCount > 0) params.set("comments", String(commentCount));
  if (danmakuCount > 0) params.set("danmaku", String(danmakuCount));

  return {
    commentCount,
    danmakuCount,
    href: commentCount > 0 || danmakuCount > 0 ? `/assets?${params.toString()}` : ""
  };
}

export function formatEngagementTargetCounts({ commentCount, danmakuCount }: EngagementTarget) {
  const parts = [
    commentCount > 0 ? `评论 ${formatReviewNumber(commentCount)}` : "评论",
    danmakuCount > 0 ? `弹幕 ${formatReviewNumber(danmakuCount)}` : "弹幕"
  ];
  return parts.join(" · ");
}

export function formatTypeOptionName(name: string) {
  return name.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

export function formatMoney(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return `¥${safeValue.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export function formatUnitPrice(value: number) {
  return formatMoney(value);
}

export function formatPercent(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return `${(safeValue * 100).toFixed(2)}%`;
}

export function formatPlatform(value: PlatformKey) {
  return value === "douyin" ? "抖音" : "B站";
}

export function getGrossTone(value: number) {
  if (value < 0) return "negative";
  if (value < 0.15) return "warning";
  return "positive";
}

export function describeQuantityInput(quantityUnit?: string) {
  if (quantityUnit === "万") return "数量直接填万，不用自己换算";
  if (quantityUnit === "千") return "数量直接填千，不用自己换算";
  return "数量直接填个数";
}

function findImportedOption(options: GrossMarginPriceOption[], metric: GrossMarginImportedMetric) {
  const hint = normalizeOptionHint(metric.optionHint);
  if (!hint) return options[0] || null;
  if (metric.service === "play" && /快速|高速|快/.test(hint)) {
    return options.find((option) => option.id.includes("play-fast") || /快速|高速|快/.test(option.name)) || options[0] || null;
  }
  if (metric.service === "play" && /正常|普通|默认/.test(hint)) {
    return options.find((option) => !option.id.includes("play-fast") && /正常|普通|默认/.test(option.name)) || options[0] || null;
  }
  return (
    options.find((option) => normalizeOptionHint(formatTypeOptionName(option.name)) === hint) ||
    options.find((option) => {
      const optionName = normalizeOptionHint(formatTypeOptionName(option.name));
      return optionName.includes(hint) || hint.includes(optionName);
    }) ||
    options[0] ||
    null
  );
}

function normalizeOptionHint(value: string) {
  return value
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function formatImportedQuantity(rawValue: string, quantityUnit: string) {
  const absolute = parseGrossMarginMetric(rawValue);
  if (absolute === null) throw new Error(`维护数量「${rawValue}」无效，请填写非负数字及万、千或个单位。`);
  const divisor = quantityUnit === "万" ? 10000 : quantityUnit === "千" ? 1000 : 1;
  return String(absolute / divisor);
}

function formatReviewLabelSuffix(line?: GrossMarginCalculationLine) {
  const name = formatTypeOptionName(line?.optionName || "");
  return name ? `（${name}）` : "";
}

function buildSplitRoundLine(
  lines: Map<GrossMarginServiceKind, GrossMarginCalculationLine>,
  platform: PlatformKey
) {
  const metrics: Array<{ service: GrossMarginServiceKind; label: string }> =
    platform === "bilibili"
      ? [
          { service: "play", label: "播放" },
          { service: "like", label: "点赞" },
          { service: "coin", label: "投币" },
          { service: "favorite", label: "收藏" },
          { service: "comment", label: "评论" },
          { service: "share", label: "分享" },
          { service: "danmaku", label: "弹幕" },
          { service: "blueLink", label: "蓝链点击" },
          { service: "mustFire", label: "必火" }
        ]
      : [
          { service: "play", label: "播放" },
          { service: "like", label: "点赞" },
          { service: "comment", label: "评论" },
          { service: "favorite", label: "收藏" },
          { service: "share", label: "转发" },
          { service: "douPlus", label: "抖加" }
        ];
  const summary = metrics
    .map(({ label, service }) => {
      const target = formatSplitRoundMetricValue(lines.get(service), 0.6);
      return target ? `${label}${target}` : "";
    })
    .filter(Boolean)
    .join("，");

  if (!summary) return "分两轮维护：第一轮";
  return `分两轮维护：第一轮，${summary}`;
}

function formatSplitRoundMetricValue(line: GrossMarginCalculationLine | undefined, ratio: number) {
  if (!line || line.quantity <= 0) return "";
  if (line.service === "douPlus" || line.service === "mustFire") return `${formatReviewMoney(Math.min(line.quantity, roundUpToStep(line.quantity * ratio, 1)))}元`;
  const absoluteValue = toAbsoluteMetricValue(line);
  const roundedValue = Math.min(absoluteValue, roundUpToStep(absoluteValue * ratio, getSplitRoundStep(line.service)));
  return formatSplitRoundCount(line.service, roundedValue);
}

function formatSplitRoundCount(service: GrossMarginServiceKind, value: number) {
  if (value <= 0) return "";
  if (service === "play") return `${formatReviewNumber(value / 10000)}万`;
  if (service === "like" && value >= 10000) {
    return `${formatReviewNumber(Number((value / 10000).toFixed(1)))}w`;
  }
  return formatReviewNumber(value);
}

function formatBilibiliPlayChannel(line?: GrossMarginCalculationLine) {
  if (!line?.optionId) return "正常通道";
  if (line.optionId.includes("play-fast")) return "快速通道";
  return "正常通道";
}

function formatReviewMetricValue(line: GrossMarginCalculationLine | undefined, platform: PlatformKey) {
  if (!line || line.quantity <= 0) return "/";
  if (line.service === "douPlus" || line.service === "mustFire") return `${formatReviewMoney(line.quantity)}元`;
  if (line.quantityUnit === "万") {
    return `${formatThreshold(line.quantity)}${platform === "bilibili" ? "W" : "万"}`;
  }
  if (line.quantityUnit === "千") {
    return formatReviewNumber(line.quantity * 1000);
  }
  return formatReviewNumber(line.quantity);
}

function formatReviewNumber(value: number) {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(2)));
}

function formatReviewMoney(value: number) {
  if (Math.abs(value - Math.round(value)) < 0.000001) {
    return String(Math.round(value));
  }
  return value.toFixed(2);
}

function formatReviewPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
