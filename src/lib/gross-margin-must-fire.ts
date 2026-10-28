import path from "path";
import { fetchWecomSheetContent } from "./wecom-account-source";
import { normalizeGrossMarginAccountName } from "./gross-margin-account-names";
import { getVideoComparableKey } from "./platform-links";
import type { GrossMarginMonitorRecord } from "./types";
import { libraryRoot } from "./storage/core";
import { readJsonFile, writeJsonFile } from "./storage/fs";
import { mustFireCacheSchema } from "./storage/schemas";

export const MUST_FIRE_URL = "https://doc.weixin.qq.com/sheet/e3_AR4AUgbrABsCN0IMot1YFTXapIyU0?scode=ABQA4wclAAsmUxoxbjAFQA1AYcAE4&tab=rc36lh";
export type MustFireRow = { account: string; project: string; url: string; amount: number };
export const extraMustFireRows: MustFireRow[] = [
  { account: "李野王SG", project: "当贝投影仪", url: "https://www.bilibili.com/video/BV1wbpX6CEEm", amount: 1000 },
  { account: "硬件侠", project: "C・ONE AI记忆卡", url: "https://www.bilibili.com/video/BV12Vpt62ERk", amount: 1000 },
  { account: "上官北", project: "豆包", url: "https://www.bilibili.com/video/BV1Koen6sEAK", amount: 500 }
];
const cachePath = () => path.join(libraryRoot(), "gross-margin", "must-fire-cache.json");
export function parseMustFireSheet(content: string): MustFireRow[] {
  const rows: MustFireRow[] = [];
  let active = false;
  let headers: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("|")) { if (line.trim()) active = /^b站-必火投放$/i.test(line.trim()); continue; }
    if (!active) continue;
    const cells = line.slice(1, -1).split(/(?<!\\)\|/).map(s => s.trim());
    if (cells.includes("必火投放金额")) { headers = cells; continue; }
    if (!headers.length || cells.every(s => !s || /^-+$/.test(s))) continue;
    // 企业微信导出不会转义标题里的竖线；仅在目标列可确认时合并标题。
    if (cells.length > headers.length) {
      const titleIndex = headers.indexOf("视频标题");
      const extra = cells.length - headers.length;
      const goal = cells[headers.indexOf("必火投放目标") + extra];
      if (titleIndex < 0 || !/^(播放量|点赞|粉丝|互动|涨粉)/.test(goal)) throw new Error("必火表列数不一致，请检查包含竖线的单元格；原缓存保留。");
      cells.splice(titleIndex, extra + 1, cells.slice(titleIndex, titleIndex + extra + 1).join("|"));
    }
    const get = (name: string) => cells[headers.indexOf(name)] || "";
    const account = get("达人昵称"), project = get("项目名称");
    if (!account && !project) continue;
    const raw = get("必火投放金额").replace(/[,，￥¥元\s]/g, "");
    if (!account || !project || !/^\d+(?:\.\d+)?$/.test(raw) || Number(raw) > 100000000) throw new Error(`必火表「${account} / ${project}」金额或身份无效，请修正后重试；原缓存保留。`);
    if (/取消|作废/.test(get("投放状态"))) continue;
    const link = get("视频链接");
    const rawUrl = link.match(/\[[^\]]*\]\(([^)]+)\)/)?.[1] || link;
    const url = /^(?:www\.)?(?:bilibili\.com|b23\.tv)\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl.match(/https?:\/\/[^\s)\]]+/)?.[0] || "";
    rows.push({ account, project, url, amount: Number(raw) });
  }
  if (!headers.length || !rows.length) throw new Error("未识别到必火投放表及有效记录，请检查表头；原缓存保留。");
  return rows;
}
let queue: Promise<unknown> = Promise.resolve();
export async function syncMustFire(options: { signal?: AbortSignal; onProgress: (attempt: number) => Promise<void> }) {
  const run = queue.catch(() => { /* 前次失败已返回调用方，允许手动重试。 */ }).then(async () => {
    const rows = parseMustFireSheet(await fetchWecomSheetContent(MUST_FIRE_URL, options));
    options.signal?.throwIfAborted();
    const cache = mustFireCacheSchema.parse({ schemaVersion: 1, fetchedAt: new Date().toISOString(), rows });
    await writeJsonFile(cachePath(), cache);
    return rows.length;
  });
  queue = run;
  return run;
}
const normalizeProject = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s・·.\-]/g, "");
export function matchMustFire(record: GrossMarginMonitorRecord, rows: MustFireRow[], projectName: string) {
  if (record.platform !== "bilibili") return undefined;
  const sameAccount = rows.filter(row => normalizeGrossMarginAccountName(row.account) === normalizeGrossMarginAccountName(record.accountName));
  const key = getVideoComparableKey(record.videoUrl);
  const sourceKeys = [...record.sourceText.matchAll(/https?:\/\/[^\s)\]]+/g)].map(match => getVideoComparableKey(match[0]));
  const project = normalizeProject(projectName);
  const matches = sameAccount.filter(row => {
    const rowKey = row.url ? getVideoComparableKey(row.url) : "";
    if (rowKey && (rowKey === key || sourceKeys.includes(rowKey))) return true;
    // 明确指向其他 BV 的投放不能按同名项目重复计入。
    if (/BV[0-9a-z]+/i.test(row.url)) return false;
    return Boolean(project && normalizeProject(row.project) === project);
  });
  return matches.length ? Math.round(matches.reduce((sum, row) => sum + row.amount, 0)) : undefined;
}
export async function getMustFireRows() {
  const raw = await readJsonFile<unknown>(cachePath());
  if (raw === null) return extraMustFireRows;
  const parsed = mustFireCacheSchema.safeParse(raw);
  if (!parsed.success) throw new Error("必火同步缓存损坏，请检查 must-fire-cache.json；未覆盖文件。");
  return [...parsed.data.rows, ...extraMustFireRows];
}
