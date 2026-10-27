import type {
  GrossMarginCalculationLine,
  GrossMarginCalculationResult,
  GrossMarginPriceOption,
  GrossMarginPriceTable,
  GrossMarginServiceKind
} from "./types";

export type GrossMarginServiceConfig = {
  service: GrossMarginServiceKind;
  label: string;
};

export const GROSS_MARGIN_SERVICE_CONFIGS: GrossMarginServiceConfig[] = [
  { service: "play", label: "播放" },
  { service: "like", label: "点赞" },
  { service: "favorite", label: "收藏" },
  { service: "share", label: "转发" },
  { service: "comment", label: "评论" },
  { service: "danmaku", label: "弹幕" },
  { service: "douPlus", label: "dou+" },
  { service: "coin", label: "投币" },
  { service: "blueLink", label: "蓝链点击" },
  { service: "mustFire", label: "必火" }
];

export function calculateGrossMargin({
  configs,
  discountPrice,
  originalPrice,
  priceInputs,
  quantityInputs,
  selectedOptions,
  table
}: {
  configs: GrossMarginServiceConfig[];
  discountPrice: number | string;
  originalPrice: number | string;
  priceInputs: Record<string, string>;
  quantityInputs: Record<GrossMarginServiceKind, string>;
  selectedOptions: Partial<Record<GrossMarginServiceKind, string>>;
  table: GrossMarginPriceTable | null;
}): GrossMarginCalculationResult {
  const errors: string[] = [];
  function amount(value: string | number | undefined, label: string) {
    const parsed = parseGrossMarginAmount(value);
    if (parsed === null) errors.push(`${label}必须是 0 到 1 亿之间的有效数字`);
    return parsed ?? 0;
  }
  const original = amount(originalPrice, "原价");
  const discount = amount(discountPrice, "折后价格");
  const lines: GrossMarginCalculationLine[] = configs.map((config) => {
    const options = table ? getActiveServiceOptions(table, config.service) : [];
    const option = getSelectedOption(options, selectedOptions[config.service]);
    const rawPrice = option ? priceInputs[option.id] ?? option.unitPrice : 0;
    if (option && typeof rawPrice === "string" && !rawPrice.trim()) errors.push(`${config.label}单价不能为空`);
    const unitPrice = option ? amount(rawPrice, `${config.label}单价`) : 0;
    const quantity = amount(quantityInputs[config.service], `${config.label}数量`);
    return {
      service: config.service,
      label: config.label,
      optionId: option?.id || "",
      optionName: option?.name || "",
      quantity,
      unitPrice,
      quantityUnit: option?.quantityUnit || "个",
      total: roundMoney(quantity * unitPrice)
    };
  });
  const maintenanceCost = roundMoney(lines.reduce((sum, line) => sum + line.total, 0));
  const grossProfit = roundMoney(discount - maintenanceCost);

  return {
    originalPrice: original,
    discountPrice: discount,
    maintenanceCost,
    grossProfit,
    grossMarginRate: original > 0 ? grossProfit / original : 0,
    rebateRate: original > 0 ? (original - discount) / original : 0,
    lines,
    errors
  };
}

export function makePriceInputs(table: GrossMarginPriceTable) {
  return Object.fromEntries(table.items.map((item) => [item.id, String(item.unitPrice)]));
}

export function makeEmptyQuantityInputs(): Record<GrossMarginServiceKind, string> {
  return {
    play: "",
    like: "",
    douPlus: "",
    mustFire: "",
    coin: "",
    comment: "",
    share: "",
    favorite: "",
    danmaku: "",
    blueLink: ""
  };
}

export function makeDefaultSelections(table: GrossMarginPriceTable) {
  return Object.fromEntries(
    GROSS_MARGIN_SERVICE_CONFIGS.map((config) => [
      config.service,
      getActiveServiceOptions(table, config.service)[0]?.id || ""
    ])
  ) as Partial<Record<GrossMarginServiceKind, string>>;
}

export function getServiceOptions(table: GrossMarginPriceTable, service: GrossMarginServiceKind) {
  return table.items.filter((item) => item.service === service);
}

export function getActiveServiceOptions(table: GrossMarginPriceTable, service: GrossMarginServiceKind) {
  return getServiceOptions(table, service).filter((item) => item.active !== false);
}

export function getSelectedOption(options: GrossMarginPriceOption[], selectedId?: string) {
  return options.find((option) => option.id === selectedId) || options[0] || null;
}

export function getMinimumQuantityWarning(
  option: GrossMarginPriceOption | null,
  rawQuantity: string,
  quantity: number
) {
  if (!option?.minimumQuantity) return "";
  if (!rawQuantity.trim()) return "";
  if (quantity >= option.minimumQuantity) return "";
  return `未达起量，至少 ${formatThreshold(option.minimumQuantity)}${option.quantityUnit}`;
}

export function formatThreshold(value: number) {
  if (Number.isInteger(value)) return String(value);
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6
  });
}

export function toAbsoluteMetricValue(line: GrossMarginCalculationLine) {
  if (line.quantityUnit === "万") return line.quantity * 10000;
  if (line.quantityUnit === "千") return line.quantity * 1000;
  return line.quantity;
}

export function getAbsoluteServiceQuantity(lines: GrossMarginCalculationLine[], service: GrossMarginServiceKind) {
  const line = lines.find((item) => item.service === service);
  if (!line || line.quantity <= 0) return 0;
  return Math.max(1, Math.round(toAbsoluteMetricValue(line)));
}

export function getSplitRoundStep(service: GrossMarginServiceKind) {
  if (service === "play") return 10000;
  if (service === "like") return 1000;
  if (service === "comment" || service === "favorite" || service === "share") return 10;
  return 1;
}

export function roundUpToStep(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

export function toAmount(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseGrossMarginAmount(value: string | number | undefined, max = 100_000_000) {
  if (value === undefined || (typeof value === "string" && !value.trim())) return 0;
  if (typeof value === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

export function parseGrossMarginMetric(value: string) {
  const match = value.trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*(万|w|千|个|元)?$/i);
  if (!match) return null;
  const multiplier = /^(万|w)$/i.test(match[2] || "") ? 10000 : match[2] === "千" ? 1000 : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) && parsed <= 100_000_000 ? parsed : null;
}

function roundMoney(value: number) {
  return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON * Math.abs(value)) * 100) / 100;
}

export function formatAmountInput(value: number) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value - Math.round(value)) < 0.000001) return String(Math.round(value));
  return String(Number(value.toFixed(2)));
}
