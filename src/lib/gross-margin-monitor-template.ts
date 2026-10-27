import type { GrossMarginPriceTable, GrossMarginServiceKind } from "./types";
import { detectVideoPlatform, extractVideoUrl, getVideoComparableKey, normalizeVideoUrlInput } from "./platform-links";
import { parseGrossMarginMetric } from "./gross-margin-calculator";

export type GrossMarginBulkMonitorItem = {
  platform: GrossMarginPriceTable["platform"];
  accountName: string;
  douyinId?: string;
  cooperationCode?: string;
  videoUrl: string;
  sourceText: string;
  targetStats: Partial<Record<GrossMarginServiceKind, number>>;
  warnings: string[];
};

export type GrossMarginBulkMonitorParseResult = {
  items: GrossMarginBulkMonitorItem[];
  warnings: string[];
};

const metricRules: Array<{
  service: GrossMarginServiceKind;
  labels: RegExp[];
}> = [
  {
    service: "play",
    labels: [
      /^(?:普通|低质|高质)?千川$/,
      /^千川无视版(?:播放)?$/,
      /^播放量?(?:（[^）]+）|\([^)]*\))?$/,
      /^科技播放$/
    ]
  },
  {
    service: "like",
    labels: [
      /^HKJ\s*点赞$/i,
      /^点赞(?:数|量)?(?:（[^）]+）|\([^)]*\))?$/,
      /^科技点赞$/,
      /^千川点赞$/
    ]
  },
  {
    service: "coin",
    labels: [/^投币(?:数|量)?$/]
  },
  {
    service: "comment",
    labels: [/^自定义评论$/, /^评论(?:数|量)?(?:（[^）]+）|\([^)]*\))?$/]
  },
  {
    service: "favorite",
    labels: [/^收藏(?:数|量)?$/]
  },
  {
    service: "share",
    labels: [/^(?:转发|分享)(?:数|量)?$/]
  },
  {
    service: "danmaku",
    labels: [/^弹幕(?:数|量)?$/, /^自定义弹幕$/]
  },
  {
    service: "mustFire",
    labels: [/^必火(?:金额)?$/]
  },
  {
    service: "blueLink",
    labels: [/^蓝链$/, /^蓝链点击(?:数|量)?$/]
  }
];

export function parseGrossMarginBulkMonitorTemplate(input: string): GrossMarginBulkMonitorParseResult {
  const blocks = splitMonitorTemplateBlocks(input);
  const warnings: string[] = [];
  const items: GrossMarginBulkMonitorItem[] = [];
  const firstPositionByVideoKey = new Map<string, number>();

  blocks.forEach((block, index) => {
    const position = index + 1;
    const item = parseMonitorTemplateBlock(block, position);
    if (!item) {
      warnings.push(`第 ${position} 段模板没有识别到视频链接，已跳过。`);
      return;
    }

    const videoKey = getVideoComparableKey(item.videoUrl);
    const firstPosition = firstPositionByVideoKey.get(videoKey);
    if (firstPosition) {
      warnings.push(`第 ${position} 条与第 ${firstPosition} 条使用同一个视频链接，已跳过重复项。`);
      return;
    }

    firstPositionByVideoKey.set(videoKey, position);
    items.push(item);
  });

  if (!blocks.length && input.trim()) {
    warnings.push("没有识别到可用模板，请确认每条至少包含账号昵称和视频链接。");
  }

  return {
    items,
    warnings
  };
}

function splitMonitorTemplateBlocks(input: string) {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const currentHasAccount = current.some(isAccountStartLine);
    const currentHasVideoLink = current.some((currentLine) => Boolean(extractVideoUrl(currentLine)));
    const startsNextBlock =
      (isAccountStartLine(line) && currentHasAccount) ||
      (isPlatformStartLine(line) && currentHasAccount && currentHasVideoLink);
    if (current.length && startsNextBlock) {
      blocks.push(current);
      current = [];
    }

    current.push(line);
  }

  if (current.length) blocks.push(current);
  return blocks.filter((block) => block.some((line) => line.includes("：") || line.includes(":")));
}

function parseMonitorTemplateBlock(lines: string[], position: number): GrossMarginBulkMonitorItem | null {
  const sourceText = lines.join("\n");
  const videoUrl = normalizeVideoUrlInput(extractVideoUrl(sourceText) || extractLineValue(lines, "视频链接"));
  if (!videoUrl) return null;
  const platform = detectVideoPlatform(videoUrl);
  if (!platform) return null;

  const targetStats: Partial<Record<GrossMarginServiceKind, number>> = {};
  const warnings: string[] = [];
  for (const line of lines) {
    const pair = parseKeyValueLine(line);
    if (!pair) continue;
    const service = resolveMetricService(pair.key);
    if (!service) continue;
    if (pair.value === "/") continue;
    const parsed = parseGrossMarginMetric(pair.value);
    if (parsed === null) throw new Error(`第 ${position} 条「${pair.key}」数量无效，请检查数字和单位。`);
    const value = Math.round(parsed);
    if (value > 0) {
      targetStats[service] = value;
    }
  }

  if (!Object.keys(targetStats).length) {
    warnings.push(`第 ${position} 条没有识别到监控目标。`);
  }

  return {
    platform,
    accountName:
      extractLineValue(lines, ["账号昵称", "账号", "账号名", "账号名称", "达人", "达人名称", "博主"]) ||
      `未命名账号 ${position}`,
    douyinId: extractLineValue(lines, ["抖音 ID", "抖音ID"]),
    cooperationCode: extractLineValue(lines, "合作码"),
    videoUrl,
    sourceText,
    targetStats,
    warnings
  };
}

function isAccountStartLine(line: string) {
  return /^(?:账号(?:昵称|名|名称)?|达人(?:名称)?|博主)\s*[：:]/.test(line);
}

function isPlatformStartLine(line: string) {
  return /^[【[]\s*(?:B站|哔哩哔哩|抖音)\s*[】\]]$/i.test(line);
}

function parseKeyValueLine(line: string) {
  const match = line.match(/^([^：:]+)\s*[：:]\s*(.+)$/);
  if (!match) return null;
  return {
    key: normalizeMetricLabel(match[1]),
    value: match[2].trim()
  };
}

function extractLineValue(lines: string[], labels: string | string[]) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  for (const line of lines) {
    const pair = parseKeyValueLine(line);
    if (!pair) continue;
    if (labelList.some((label) => normalizeMetricLabel(label) === pair.key)) return pair.value;
  }
  return "";
}

function resolveMetricService(label: string) {
  return metricRules.find((rule) => rule.labels.some((pattern) => pattern.test(label)))?.service || null;
}

function normalizeMetricLabel(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
