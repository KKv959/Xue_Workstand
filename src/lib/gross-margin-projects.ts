import type { GrossMarginMonitorRecord, GrossMarginProjectOrder, GrossMarginProjectSource, JobRecord } from "./types";
import { normalizeGrossMarginAccountName } from "./gross-margin-account-names";
import { getVideoComparableKey } from "./platform-links";

export function getGrossMarginProjectSyncError(job: JobRecord, source: GrossMarginProjectSource) {
  return `${job.error || job.message || "项目同步未完成"}${source.fetchedAt ? "；当前使用上次成功缓存" : "；暂无可用项目缓存，可手动填写价格"}`;
}

export function getGrossMarginProjectMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find(part => part.type === "year")!.value}-${parts.find(part => part.type === "month")!.value}`;
}

function sheetMonth(title: string) {
  const match = title.replace(/^#+\s*/, "").trim().match(/^(\d{2}|\d{4})[.年/-](\d{1,2})月$/);
  if (!match) return "";
  return `${match[1].length === 2 ? `20${match[1]}` : match[1]}-${match[2].padStart(2, "0")}`;
}

export function parseWecomProjectSheet(markdown: string, month: string): GrossMarginProjectOrder[] {
  const orders: GrossMarginProjectOrder[] = [];
  let inMonth = false;
  let foundMonth = false;
  let foundHeaders = false;
  let headers: string[] | null = null;
  const occurrences = new Map<string, number>();
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (!trimmed) continue;
      inMonth = sheetMonth(trimmed) === month;
      foundMonth ||= inMonth;
      headers = null;
      continue;
    }
    if (!inMonth) continue;
    const cells = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined).split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, "|"));
    if (cells.every(value => /^:?-+:?$/.test(value))) continue;
    if (!headers) {
      if (cells.includes("下单金额")) {
        headers = cells;
        foundHeaders = true;
        for (const aliases of [["账号", "账号名", "账号昵称"], ["投放产品", "项目", "项目名称"], ["返点金额"], ["最终合作价格", "最终合作价"]]) {
          if (!aliases.some(alias => headers!.includes(alias))) throw new Error(`当月项目表缺少「${aliases[0]}」列，请检查表头。`);
        }
      }
      continue;
    }
    // 账号列在当月表中出现两次，必须取前面的业务账号列。
    const cell = (...aliases: string[]) => cells[headers!.findIndex(header => aliases.includes(header))] || "";
    const accountName = cell("账号", "账号名", "账号昵称");
    const projectName = cell("投放产品", "项目", "项目名称");
    const platformText = cell("平台");
    const platforms = [/B站|哔哩哔哩|bilibili/i.test(platformText) ? "bilibili" as const : null, /抖音|douyin/i.test(platformText) ? "douyin" as const : null].filter(value => value !== null);
    if (!accountName || !projectName || !platforms.length) continue;
    const warning: string[] = [];
    const money = (label: string, value: string) => {
      const normalized = value.replace(/[,，￥¥元\s]/g, "");
      const amount = /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
      if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
        warning.push(`${label}${normalized ? "无效" : "未填写"}`);
        return null;
      }
      return amount;
    };
    const orderAmount = money("下单金额", cell("下单金额"));
    const rebateAmount = money("返点金额", cell("返点金额"));
    const finalPrice = money("最终合作价格", cell("最终合作价格", "最终合作价"));
    if (orderAmount !== null && rebateAmount !== null && rebateAmount > orderAmount) warning.push("返点金额超过下单金额，无法换算比例");
    const link = cell("链接");
    const videoUrl = link.match(/\[[^\]]*\]\(([^)]+)\)/)?.[1]?.trim() || (/^https?:\/\//.test(link) ? link : "");
    const date = cell("实际发布日期") || cell("锁定档期") || cell("锁档日期");
    for (const platform of platforms) {
      // 身份跟随记录内容，插入新行后不会把当前选择错配到另一项目。
      const identity = encodeURIComponent(JSON.stringify([month, platform, accountName, projectName, videoUrl, date, orderAmount, rebateAmount, finalPrice]));
      const occurrence = (occurrences.get(identity) || 0) + 1;
      occurrences.set(identity, occurrence);
      orders.push({ id: `${identity}:${occurrence}`, month, platform, accountName, projectName,
        orderAmount, rebateAmount, finalPrice, videoUrl, date, warning: warning.join("；") || undefined });
    }
  }
  if (!foundMonth) throw new Error(`企业微信项目表中没有 ${month} 工作表，请创建当月工作表后重试。`);
  if (!foundHeaders) throw new Error("当月项目表没有识别到报价表头，请检查下单金额等列。");
  return orders;
}

export function findGrossMarginProjectOrders(orders: GrossMarginProjectOrder[], platform: GrossMarginProjectOrder["platform"], accountName: string) {
  const name = normalizeGrossMarginAccountName(accountName);
  return name ? orders.filter(order => order.platform === platform && normalizeGrossMarginAccountName(order.accountName) === name) : [];
}

export function chooseGrossMarginProjectOrder(orders: GrossMarginProjectOrder[], videoUrl: string) {
  const key = videoUrl ? getVideoComparableKey(videoUrl) : "";
  const matches = key ? orders.filter(order => order.videoUrl && getVideoComparableKey(order.videoUrl) === key) : [];
  return matches.length === 1 ? matches[0] : orders.length === 1 ? orders[0] : null;
}

export function getGrossMarginMonitorProjectName(record: GrossMarginMonitorRecord, orders: GrossMarginProjectOrder[]) {
  if (record.maintenanceProject?.name.trim()) return record.maintenanceProject.name.trim();
  // Earlier exports briefly saved the product name here; grouped imports use this field for a batch name.
  if (!record.projectId && record.projectName?.trim()) return record.projectName.trim();
  const candidates = findGrossMarginProjectOrders(orders, record.platform, record.accountName);
  const key = getVideoComparableKey(record.videoUrl);
  const exact = key ? candidates.filter(order => order.videoUrl && getVideoComparableKey(order.videoUrl) === key) : [];
  const names = [...new Set(exact.map(order => order.projectName.trim()).filter(Boolean))];
  // Even a single current-month project cannot identify an older video by account alone.
  return names.length === 1 ? names[0] : "";
}

export function getGrossMarginProjectPrices(order: GrossMarginProjectOrder) {
  const rate = order.orderAmount !== null && order.rebateAmount !== null && order.rebateAmount <= order.orderAmount
    ? order.orderAmount > 0 ? order.rebateAmount / order.orderAmount * 100 : 0
    : null;
  return { originalPrice: order.orderAmount === null ? "" : String(order.orderAmount), rebateRate: rate === null ? "" : String(Number(rate.toFixed(6))), discountPrice: order.finalPrice === null ? "" : String(order.finalPrice) };
}
