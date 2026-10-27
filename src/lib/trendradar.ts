import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { safeSourceUrl } from "./hotspot-radar/collector";
import type { CollectedSource } from "./hotspot-radar/collector";
import type { TrendRadarFeed, TrendRadarItem } from "./trendradar-types";

const execFileAsync = promisify(execFile);
const rowSchema = z.object({
  title: z.string(), url: z.string(), source_id: z.string(), source_name: z.string().nullable(),
  first_crawl_time: z.string(), latest_time: z.string(), observed_at: z.string(),
  last_crawl_time: z.string(), rank: z.number().nullable().optional(), guid: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(), summary: z.string().nullable().optional()
});

async function windowDatabases(root: string, directory: string, hours: number, now: number) {
  let files: string[];
  try { files = await readdir(path.join(root, directory)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`无法访问 TrendRadar ${directory} 目录，请检查读取权限`, { cause: error });
  }
  const day = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
  const from = day(now - hours * 3600000), to = day(now);
  return files.filter(name => /^\d{4}-\d{2}-\d{2}\.db$/.test(name) && name.slice(0, 10) >= from && name.slice(0, 10) <= to)
    .sort().reverse().map(file => path.join(root, directory, file));
}

async function readItems(file: string, kind: TrendRadarItem["kind"], signal?: AbortSignal) {
  const rss = kind === "rss";
  const table = rss ? "rss_items" : "news_items";
  const sources = rss ? "rss_feeds" : "platforms";
  const records = rss ? "rss_crawl_records" : "crawl_records";
  const sourceKey = rss ? "feed_id" : "platform_id";
  const sql = `WITH latest AS (SELECT crawl_time,created_at FROM ${records} ORDER BY id DESC LIMIT 1)
    SELECT n.title,n.url,n.${sourceKey} AS source_id,p.name AS source_name,n.first_crawl_time,n.last_crawl_time,
      latest.crawl_time AS latest_time,latest.created_at AS observed_at,
      ${rss ? "n.guid,n.published_at,n.summary" : "n.rank"}
    FROM ${table} n LEFT JOIN ${sources} p ON p.id=n.${sourceKey} CROSS JOIN latest
    ORDER BY n.id DESC LIMIT 2000`;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", file, sql], { signal, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    return z.array(rowSchema).parse(JSON.parse(stdout || "[]"));
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`读取 TrendRadar ${rss ? "RSS" : "热榜"} 数据库失败，请检查 sqlite3 是否安装、数据库是否完整：${path.basename(file)}`, { cause: error });
  }
}

export async function getTrendRadarFeed(signal?: AbortSignal, root = process.env.TRENDRADAR_OUTPUT_DIR || path.join(homedir(), "Applications/trendradar/output"), options: { maxAgeHours?: number; now?: number; kinds?: TrendRadarItem["kind"][] } = {}): Promise<TrendRadarFeed> {
  const hours = options.maxAgeHours ?? Number(process.env.HOTSPOT_RADAR_MAX_AGE_HOURS || 72);
  if (!Number.isFinite(hours) || hours < 6 || hours > 168) throw new Error("TrendRadar 读取窗口须为 6～168 小时");
  const now = options.now ?? Date.now();
  const kinds = options.kinds || ["hotlist", "rss"];
  const failures: string[] = [];
  const files = await Promise.all((["hotlist", "rss"] as const).map(async kind => {
    if (!kinds.includes(kind)) return [];
    try { return await windowDatabases(root, kind === "rss" ? "rss" : "news", hours, now); }
    catch (error) { signal?.throwIfAborted(); failures.push(error instanceof Error ? error.message : "读取 TrendRadar 目录失败"); return []; }
  }));
  const missing = files.flatMap((group, index) => group.length || !kinds.includes(index ? "rss" : "hotlist") ? [] : [index ? "窗口内无 RSS 数据库" : "窗口内无热榜数据库"]);
  // 每类按日期倒序读取，限制同时打开的数据库数；先保留最新内容和排名。
  let readableDatabases = 0;
  const rows = await Promise.all(files.map(async (group, index) => {
    const entries = [];
    for (const file of group) {
      signal?.throwIfAborted();
      try {
        const databaseRows = await readItems(file, index ? "rss" : "hotlist", signal);
        readableDatabases++;
        for (const row of databaseRows) entries.push({ ...row, databaseDay: path.basename(file, ".db"), latestDay: path.basename(group[0], ".db") });
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(error instanceof Error ? error.message : "读取 TrendRadar 数据库失败");
      }
    }
    return entries;
  }));
  const items: TrendRadarItem[] = [];
  const seen = new Set<string>();
  let invalidUrls = 0;
  rows.forEach((entries, index) => entries.forEach(row => {
    const kind = index ? "rss" : "hotlist";
    let url: string;
    try { url = safeSourceUrl(row.url); }
    catch { invalidUrls++; return; } // 不公开不安全链接，同时向页面报告排除数量。
    const key = `${kind}|${row.source_id}|${row.guid || url}`;
    const observedAt = `${row.databaseDay}T${row.last_crawl_time.replace("-", ":")}:00+08:00`;
    const observed = Date.parse(observedAt);
    if (!Number.isFinite(observed) || observed < now - hours * 3600000 || observed > now + 3600000) return;
    if (seen.has(key)) return;
    seen.add(key);
    // TrendRadar feedparser 分支将 UTC struct_time 输出为不带时区的 ISO 字符串。
    const published = row.published_at?.trim();
    const publication = published && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(published) ? `${published}Z` : published;
    items.push({
      id: `trend:${kind}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
      title: row.title, url, source: row.source_name || row.source_id, sourceId: row.source_id, kind,
      publishedAt: publication && Number.isFinite(Date.parse(publication)) ? new Date(publication).toISOString() : undefined,
      summary: row.summary?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600),
      observedAt,
      rank: row.rank || undefined, isNew: row.databaseDay === row.latestDay && row.first_crawl_time === row.latest_time,
    });
  }));
  // 两类资讯交替排列，避免某类来源占满首屏；各类内部新增优先。
  const groups = [items.filter(item => item.kind === "hotlist"), items.filter(item => item.kind === "rss")];
  for (const group of groups) group.sort((a, b) => Number(b.isNew) - Number(a.isNew) || (b.publishedAt || "").localeCompare(a.publishedAt || "") || (a.rank || 999) - (b.rank || 999));
  const ordered = Array.from({ length: Math.max(...groups.map(group => group.length)) }, (_, index) => groups.flatMap(group => group[index] ? [group[index]] : [])).flat();
  const lastRuns = rows.flatMap(entries => entries[0] ? [entries[0].observed_at] : []);
  return {
    items: ordered, generatedAt: lastRuns.sort().at(-1) || "", available: readableDatabases > 0, missing,
    warnings: [...failures, ...(invalidUrls ? [`已排除 ${invalidUrls} 条不安全链接`] : []), ...(rows.some(entries => entries.length >= 2000) ? ["每个日库最多读取最近 2000 条，历史候选可能不完整"] : [])],
    counts: { hotlist: groups[0].length, rss: groups[1].length, newItems: items.filter(item => item.isNew).length }
  };
}

export function selectTrendRadarSources(feed: TrendRadarFeed, ids: string[]): CollectedSource[] {
  const selected = new Set(ids);
  if (!selected.size || selected.size > 24) throw new Error("每次请选择 1～24 条 TrendRadar 候选");
  const items = feed.items.filter(item => selected.has(item.id));
  if (items.length !== selected.size) throw new Error("部分候选已不在当前数据库中，请刷新候选后重新选择");
  return trendRadarItemsToSources(items);
}

export function trendRadarItemsToSources(items: TrendRadarItem[]): CollectedSource[] {
  const grouped = new Map<string, CollectedSource>();
  const checkedAt = new Date().toISOString();
  for (const item of items) {
    const sourceId = `trend:${item.kind}:${item.sourceId}`;
    let group = grouped.get(sourceId);
    if (!group) {
      group = { source: { id: sourceId, name: item.source, url: item.url, scope: "TrendRadar 候选", type: "trendradar" }, checkedAt, items: [] };
      grouped.set(sourceId, group);
    }
    group.items.push({ id: item.id, sourceId, source: item.source, originalSource: item.source, title: item.title, url: safeSourceUrl(item.url), summary: item.summary || "", publishedAt: item.publishedAt || "", collectedAt: checkedAt, category: "", inputKind: item.kind, observedAt: item.observedAt, metrics: { rank: item.rank } });
  }
  return [...grouped.values()];
}
