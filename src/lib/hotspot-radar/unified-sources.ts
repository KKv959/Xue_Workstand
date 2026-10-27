import { getTrendRadarFeed, trendRadarItemsToSources } from "../trendradar";
import { canonicalRadarUrl } from "./collector";
import { coarseFilter, isLowValueRoutineSports } from "./source-rules.mjs";
import type { RadarSignal } from "./source-rules.mjs";
import type { CollectedSource, RadarRefreshOptions } from "./collector";
import type { RadarPipelineConfig } from "./config";

export async function collectUnifiedSources(config: RadarPipelineConfig, options: RadarRefreshOptions): Promise<CollectedSource[]> {
  const collected: CollectedSource[] = [];
  const failed = (id: string, name: string, message: string): CollectedSource => ({ source: { id, name, url: "", type: "unified", scope: "统一资讯池" }, checkedAt: new Date().toISOString(), items: [], error: message });
  try {
    const feed = await getTrendRadarFeed(options.signal, undefined, { maxAgeHours: config.maxAgeHours, kinds: config.sources });
    collected.push(...trendRadarItemsToSources(feed.items));
    if (feed.missing.length || feed.warnings.length) collected.push(failed("trendradar-status", "TrendRadar 读取状态", [...feed.missing, ...feed.warnings].join("；")));
  } catch (error) {
    options.signal?.throwIfAborted();
    collected.push(failed("trendradar", "TrendRadar", error instanceof Error ? error.message : "读取 TrendRadar 失败"));
  }
  options.signal?.throwIfAborted();
  const now = Date.now();
  for (const entry of collected) {
    const priorCount = entry.items.length;
    entry.items = entry.items.filter(item => {
      const timestamp = Date.parse(item.publishedAt || item.observedAt || "");
      return Number.isFinite(timestamp) && now - timestamp <= config.maxAgeHours * 3600000 && timestamp <= now + 3600000;
    });
    if (priorCount && !entry.items.length) entry.error = [entry.error, `来源数据超过 ${config.maxAgeHours} 小时或时间缺失，请先更新采集服务`].filter(Boolean).join("；");
  }
  return collected;
}

/** 每类、每来源轮转，保留弱规则评分以外的游戏线索给模型判断。 */
export function selectUnifiedCandidates(items: RadarSignal[], config: RadarPipelineConfig): RadarSignal[] {
  const scores = new Map(coarseFilter(items).map(item => [item.id, item.coarseScore || 0]));
  const eligible = items.filter(item => !isLowValueRoutineSports(item) && !config.exclude.some(word => `${item.title} ${item.summary}`.toLowerCase().includes(word.toLowerCase())));
  const queues = new Map<string, RadarSignal[]>();
  for (const item of eligible) {
    const key = `${item.inputKind || "hotlist"}:${item.sourceId}`;
    const queue = queues.get(key) || [];
    queue.push(item); queues.set(key, queue);
  }
  for (const [key, queue] of queues) queues.set(key, queue.sort((a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0) || (b.publishedAt || b.observedAt || "").localeCompare(a.publishedAt || a.observedAt || "") || a.id.localeCompare(b.id)).slice(0, config.perSourceLimit));
  const kinds = config.sources.map(kind => [...queues.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, values]) => values));
  const selected: RadarSignal[] = [];
  let changed = true;
  while (selected.length < config.candidateLimit && changed) {
    changed = false;
    for (const sources of kinds) {
      const queue = sources.shift();
      if (!queue) continue;
      const item = queue.shift();
      if (queue.length) sources.push(queue);
      if (item) { selected.push(item); changed = true; }
      if (selected.length >= config.candidateLimit) break;
    }
  }
  return selected;
}

/** 只做同 URL 去重，事件语义归并交给后续模型，避免规则误合并。 */
export function deduplicateUnifiedSignals(items: RadarSignal[]): RadarSignal[] {
  const byUrl = new Map<string, RadarSignal>();
  for (const item of items) {
    const key = canonicalRadarUrl(item.url);
    const existing = byUrl.get(key);
    if (existing) existing.related!.push(item);
    else byUrl.set(key, { ...item, related: [] });
  }
  return [...byUrl.values()];
}
