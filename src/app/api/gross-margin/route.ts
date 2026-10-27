import { z } from "zod";
import { apiJson, formatApiError, parseJsonBody } from "@/lib/api-route";
import { parseGrossMarginBulkMonitorTemplate } from "@/lib/gross-margin-monitor-template";
import { getGrossMarginProjectSource } from "@/lib/storage/gross-margin-projects";
import { findGrossMarginProjectOrders } from "@/lib/gross-margin-projects";
import {
  refreshGrossMarginMonitorRecord,
  refreshGrossMarginMonitorRecords,
  resolveGrossMarginVideoAccount
} from "@/lib/gross-margin-refresh";
import {
  appendGrossMarginPlaySample,
  deleteGrossMarginMonitorRecord,
  getGrossMarginLibrary,
  saveGrossMarginPriceTable,
  saveGrossMarginReviewTemplate,
  updateGrossMarginMonitorRecord,
  upsertGrossMarginMonitorRecord
} from "@/lib/storage";
import type {
  GrossMarginPriceTable,
  GrossMarginServiceKind
} from "@/lib/types";
import {
  detectVideoPlatform,
  extractBvid,
  extractDouyinAwemeId,
  extractVideoUrl,
  getVideoComparableKey,
  normalizeVideoUrlInput
} from "@/lib/platform-links";
import { safeSegment, shortHash } from "@/lib/utils";
import { parseGrossMarginAmount, parseGrossMarginMetric } from "@/lib/gross-margin-calculator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const platformSchema = z.enum(["douyin", "bilibili"]);
const serviceSchema = z.enum(["play", "like", "douPlus", "mustFire", "coin", "comment", "share", "favorite", "danmaku", "blueLink"]);
const amountSchema = z.preprocess(
  value => typeof value === "string" && value.trim() ? parseGrossMarginAmount(value) : value,
  z.number({ invalid_type_error: "请填写有效的非负数字" }).finite().min(0, "金额不能小于 0").max(100_000_000, "金额过大，请检查输入")
);
const minimumQuantitySchema = amountSchema.refine(value => value > 0, "起量必须大于 0");
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("savePriceTable"),
    platform: platformSchema,
    items: z.array(
      z.object({
        id: z.string().min(1, "单价项缺少 ID"),
        service: serviceSchema,
        name: z.string().trim().min(1, "请填写单价项名称").max(40, "单价项名称太长"),
        unitPrice: amountSchema,
        quantityUnit: z.enum(["万", "千", "个", "元"], { errorMap: () => ({ message: "数量单位只支持万、千、个或元" }) }),
        minimumQuantity: minimumQuantitySchema.nullish(),
        note: z.string().trim().max(120, "备注太长").optional(),
        active: z.boolean().optional()
      })
    )
  }),
  z.object({
    action: z.literal("saveReviewTemplate"),
    platform: platformSchema,
    content: z.string().trim().min(1, "文案模板不能为空")
  }),
  z.object({
    action: z.literal("resolveVideoAccount"),
    videoUrl: z.string().trim().url("请粘贴完整的视频链接")
  }),
  z.object({
    action: z.literal("saveMonitorRecord"),
    platform: platformSchema,
    accountName: z.string().trim().optional(),
    projectName: z.string().trim().optional(),
    projectOrderId: z.string().trim().min(1, "请选择维护项目").optional(),
    videoUrl: z.string().trim().min(1, "请填写视频链接"),
    sourceText: z.string().min(1, "监控记录缺少维护目标文案"),
    targetStats: z.record(serviceSchema, amountSchema).optional()
  }),
  z.object({
    action: z.literal("bulkSaveMonitorRecords"),
    template: z.string().trim().min(1, "请先粘贴监控模板"),
    projectName: z.string().trim().max(80, "项目名太长").optional(),
    createProject: z.boolean().optional()
  }),
  z.object({
    action: z.literal("refreshMonitorRecord"),
    recordId: z.string().trim().min(1, "缺少监控记录 ID")
  }),
  z.object({
    action: z.literal("refreshMonitorRecords"),
    recordIds: z.array(z.string().trim().min(1, "监控记录 ID 不能为空")).optional()
  }),
  z.object({
    action: z.literal("updateMonitorPlayTarget"),
    recordId: z.string().trim().min(1, "缺少监控记录 ID"),
    target: amountSchema.refine(value => value > 0, "播放量目标必须大于 0")
  }),
  z.object({
    action: z.literal("updateMonitorPlayCurrent"),
    recordId: z.string().trim().min(1, "缺少监控记录 ID"),
    current: amountSchema
  }),
  z.object({
    action: z.literal("updateMonitorMustFireCurrent"),
    recordId: z.string().trim().min(1, "缺少监控记录 ID"),
    current: amountSchema.refine(Number.isInteger, "必火已投金额请填写整元"),
    revision: z.number().int().nonnegative("记录版本无效")
  }),
  z.object({
    action: z.literal("updateMonitorProject"),
    recordId: z.string().trim().min(1, "缺少监控记录 ID"),
    projectOrderId: z.string().trim().min(1, "项目报价 ID 无效").optional(),
    projectName: z.string().trim().max(80, "项目名太长").optional(),
    revision: z.number().int().nonnegative("记录版本无效")
  }),
  z.object({
    action: z.literal("deleteMonitorRecord"),
    recordId: z.string().trim().min(1, "缺少监控记录 ID")
  })
]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("projectOrders") === "1") return apiJson(() => getGrossMarginProjectSource(), { fallbackMessage: "读取当月项目报价缓存失败" });
  const refreshAccounts = params.get("refreshAccounts") === "1";
  const cachedAccountsOnly = params.get("cachedAccounts") === "1";
  return apiJson(() => getGrossMarginLibrary({ refreshAccounts, cachedAccountsOnly }), {
    fallbackMessage: "读取毛利单价表失败",
    status: 500,
    formatError: formatGrossMarginError
  });
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, mutationSchema);
    if (input.action === "resolveVideoAccount") {
      return resolveGrossMarginVideoAccount(input.videoUrl, { signal: request.signal });
    }
    if (input.action === "saveMonitorRecord") {
      const record = await saveMonitorRecordFromInput(input);
      return { record, library: await getGrossMarginLibrary() };
    }
    if (input.action === "bulkSaveMonitorRecords") {
      const result = await bulkSaveMonitorRecordsFromInput(input);
      return { ...result, library: await getGrossMarginLibrary() };
    }
    if (input.action === "refreshMonitorRecord") {
      const record = await refreshGrossMarginMonitorRecord(input.recordId, { signal: request.signal });
      return { record, library: await getGrossMarginLibrary() };
    }
    if (input.action === "refreshMonitorRecords") {
      const records = await refreshGrossMarginMonitorRecords(input.recordIds, { signal: request.signal });
      return { records, library: await getGrossMarginLibrary() };
    }
    if (input.action === "updateMonitorPlayTarget") {
      const record = await updateMonitorPlayTarget(input.recordId, input.target);
      return { record, library: await getGrossMarginLibrary() };
    }
    if (input.action === "updateMonitorPlayCurrent") {
      const record = await updateMonitorPlayCurrent(input.recordId, input.current);
      return { record, library: await getGrossMarginLibrary() };
    }
    if (input.action === "updateMonitorMustFireCurrent") {
      const record = await updateGrossMarginMonitorRecord(input.recordId, current => {
        if (current.platform !== "bilibili" || !current.targetStats.mustFire) {
          throw Object.assign(new Error("该记录没有必火目标，无法填写已投金额。"), { statusCode: 400 });
        }
        return { ...current, currentStats: { ...current.currentStats, mustFire: input.current }, updatedAt: new Date().toISOString() };
      }, input.revision);
      return { record, library: await getGrossMarginLibrary() };
    }
    if (input.action === "updateMonitorProject") {
      const source = await getGrossMarginProjectSource();
      const record = await updateGrossMarginMonitorRecord(input.recordId, current => {
        const order = input.projectOrderId
          ? findGrossMarginProjectOrders(source.orders, current.platform, current.accountName).find(item => item.id === input.projectOrderId)
          : undefined;
        const projectName = input.projectName?.trim() || order?.projectName;
        if (!projectName) throw Object.assign(new Error("请选择维护项目或填写自定义项目名称。"), { statusCode: 400 });
        return {
          ...current,
          maintenanceProject: {
            orderId: order?.id || `custom-${shortHash(`${current.platform}:${current.accountName}:${projectName}`)}`,
            name: projectName
          },
          updatedAt: new Date().toISOString()
        };
      }, input.revision);
      return { record, library: await getGrossMarginLibrary() };
    }
    if (input.action === "deleteMonitorRecord") {
      const result = await deleteGrossMarginMonitorRecord(input.recordId);
      return { ...result, library: await getGrossMarginLibrary() };
    }
    if (input.action === "saveReviewTemplate") {
      const template = await saveGrossMarginReviewTemplate(input);
      return { template, library: await getGrossMarginLibrary() };
    }
    const table = await saveGrossMarginPriceTable(input);
    return { table, library: await getGrossMarginLibrary() };
  }, {
    fallbackMessage: "保存毛利配置失败",
    formatError: formatGrossMarginError
  });
}

function formatGrossMarginError(error: unknown, fallbackMessage: string) {
  if (error instanceof z.ZodError) {
    return formatApiError(error, fallbackMessage);
  }

  if (isMissingOpenCliError(error)) {
    return "未检测到 opencli。数据维护 / 数据监控页面可以继续使用，但刷新 B站/抖音数据前请先运行 install-deps.cmd 安装 opencli。";
  }

  return error instanceof Error ? error.message : fallbackMessage;
}

function isMissingOpenCliError(error: unknown) {
  return error instanceof Error && /opencli/i.test(error.message) && /未检测到|not found|enoent/i.test(error.message);
}

type MonitorPlatform = GrossMarginPriceTable["platform"];

async function saveMonitorRecordFromInput(input: z.infer<typeof mutationSchema> & { action: "saveMonitorRecord" }) {
  const parsed = parseMaintenanceTemplate(input.sourceText);
  const targetStats = {
    ...parsed.stats,
    ...(input.targetStats || {})
  };
  const resolvedVideo = resolveVideoUrl(input.videoUrl, input.sourceText);
  const videoUrl = normalizeVideoUrlInput(resolvedVideo.url);
  const platform = resolveMonitorPlatform(videoUrl, parsed.platform, input.platform);
  const videoKey = getVideoComparableKey(videoUrl);
  const accountName = input.accountName || parsed.accountName;
  const order = input.projectOrderId
    ? findGrossMarginProjectOrders((await getGrossMarginProjectSource()).orders, platform, accountName)
      .find(item => item.id === input.projectOrderId)
    : undefined;
  if (input.projectOrderId && !order) throw Object.assign(new Error("项目报价已更新，请在数据维护中重新选择项目后导出。"), { statusCode: 400 });
  return upsertGrossMarginMonitorRecord({
    platform,
    accountName,
    projectName: input.projectName,
    maintenanceProject: order ? { orderId: order.id, name: order.projectName } : undefined,
    videoUrl,
    videoKey,
    sourceText: input.sourceText,
    targetStats,
    warnings: resolvedVideo.warnings
  });
}

async function bulkSaveMonitorRecordsFromInput(input: z.infer<typeof mutationSchema> & { action: "bulkSaveMonitorRecords" }) {
  const parsed = parseGrossMarginBulkMonitorTemplate(input.template);
  if (!parsed.items.length) {
    throw new Error(parsed.warnings[0] || "没有识别到可添加的监控模板。");
  }

  const trimmedProjectName = input.projectName?.trim() || "";
  const shouldCreateProject = Boolean(input.createProject && parsed.items.length > 1);
  const projectName = shouldCreateProject ? trimmedProjectName || makeDefaultGrossMarginProjectName(parsed.items.length) : "";
  const projectId = projectName ? safeSegment(`${projectName}-${shortHash(input.template)}`, shortHash(projectName)) : "";
  const records = await Promise.all(
    parsed.items.map((item) =>
      upsertGrossMarginMonitorRecord({
        platform: resolveMonitorPlatform(item.videoUrl, item.platform),
        accountName: item.accountName,
        projectId: projectId || undefined,
        projectName: projectName || undefined,
        videoUrl: item.videoUrl,
        videoKey: getVideoComparableKey(item.videoUrl),
        sourceText: item.sourceText,
        targetStats: item.targetStats
      })
    )
  );

  return {
    records,
    parsed,
    project: projectId ? { id: projectId, name: projectName } : null
  };
}

async function updateMonitorPlayTarget(recordId: string, target: number) {
  return updateGrossMarginMonitorRecord(recordId, (record) => ({
    ...record,
    targetStats: {
      ...record.targetStats,
      play: Math.round(target)
    },
    updatedAt: new Date().toISOString()
  }));
}

async function updateMonitorPlayCurrent(recordId: string, current: number) {
  return updateGrossMarginMonitorRecord(recordId, (record) => {
    if (record.platform !== "douyin") {
      throw new Error("只有抖音监控需要手动填写当前播放量。");
    }
    const updatedAt = new Date().toISOString();
    const roundedCurrent = Math.round(current);
    return {
      ...record,
      currentStats: {
        ...(record.currentStats || {}),
        play: roundedCurrent
      },
      playSamples: appendGrossMarginPlaySample(record.playSamples, roundedCurrent, updatedAt, "manual"),
      updatedAt
    };
  });
}

function parseMaintenanceTemplate(template: string) {
  const normalized = template.replace(/\r/g, "");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stats: Partial<Record<GrossMarginServiceKind, number>> = {};
  const lineRules: Array<{ service: GrossMarginServiceKind; patterns: RegExp[] }> = [
    { service: "play", patterns: [/播放量(?:（[^）]+）)?\s*[：:]\s*([^\n]+)/i] },
    { service: "like", patterns: [/点赞(?:（[^）]+）)?\s*[：:]\s*([^\n]+)/i] },
    { service: "coin", patterns: [/投币\s*[：:]\s*([^\n]+)/i] },
    { service: "favorite", patterns: [/收藏\s*[：:]\s*([^\n]+)/i] },
    { service: "comment", patterns: [/评论(?:（[^）]+）)?\s*[：:]\s*([^\n]+)/i] },
    { service: "share", patterns: [/分享\s*[：:]\s*([^\n]+)/i, /转发\s*[：:]\s*([^\n]+)/i] },
    { service: "danmaku", patterns: [/弹幕\s*[：:]\s*([^\n]+)/i] },
    { service: "blueLink", patterns: [/蓝链点击\s*[：:]\s*([^\n]+)/i] }
  ];

  for (const rule of lineRules) {
    for (const pattern of rule.patterns) {
      const match = normalized.match(pattern);
      if (!match?.[1]) continue;
      const raw = match[1].trim();
      if (raw === "/") break;
      const value = parseGrossMarginMetric(raw);
      if (value === null) throw new Error(`模板中的${rule.service}数量无效，请检查数字和单位。`);
      stats[rule.service] = Math.round(value);
      break;
    }
  }

  return {
    accountName: extractLineValue(lines, ["账号", "账号名", "账号名称", "账号昵称", "达人", "达人名称", "博主"]),
    platform: (normalized.includes("【抖音】") ? "douyin" : normalized.includes("【B站】") ? "bilibili" : undefined) as
      | MonitorPlatform
      | undefined,
    stats
  };
}

function extractLineValue(lines: string[], labels: string | string[]) {
  const labelList = Array.isArray(labels) ? labels : [labels];
  for (const label of labelList) {
    const pattern = new RegExp(`^${escapeRegExp(label)}\\s*[：:]\\s*(.+)$`, "i");
    const matched = lines.find((line) => pattern.test(line));
    if (matched) return matched.replace(pattern, "$1").trim();
  }
  return "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveMonitorPlatform(url: string, templatePlatform?: MonitorPlatform, platformHint?: MonitorPlatform) {
  const platformFromUrl = detectVideoPlatform(url);
  if (platformFromUrl) return platformFromUrl;
  if (extractBvid(url)) return "bilibili" as const;
  if (extractDouyinAwemeId(url)) return "douyin" as const;
  if (templatePlatform) return templatePlatform;
  if (platformHint) return platformHint;
  throw new Error("没有识别到平台，请粘贴视频链接。");
}

function resolveVideoUrl(explicitUrl: string, template: string) {
  const direct = extractVideoUrl(explicitUrl) || explicitUrl.trim();
  const urlMatch = extractTemplateUrl(template);
  const warnings: string[] = [];
  if (direct && urlMatch && getVideoComparableKey(direct) !== getVideoComparableKey(urlMatch)) {
    warnings.push("视频链接与维护模板里的链接不一致，已优先使用维护模板里的链接。");
  }
  if (urlMatch) return { url: urlMatch, warnings };
  if (direct) return { url: direct, warnings };
  throw new Error("没有从模板里识别到视频链接，请补充链接后再查询。");
}

function extractTemplateUrl(template: string) {
  return extractVideoUrl(template);
}

function makeDefaultGrossMarginProjectName(count: number) {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${month}${day} 批量监控 ${count} 条`;
}
