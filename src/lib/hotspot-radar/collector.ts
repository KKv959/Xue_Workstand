import type { RadarPipelineConfig } from "./config";
import type { HotspotEvent } from "../types";
import * as rules from "./source-rules.mjs";
import type { RadarSignal, RadarSource } from "./source-rules.mjs";

export type RadarProgress = { completed: number; total: number; sourceName: string; failed: boolean; stage?: string; dataChanged?: boolean };
export type RadarRefreshOptions = { pipeline?: RadarPipelineConfig; previousTopics?: HotspotEvent[]; retryReport?: boolean; continueAnalysis?: boolean; trendRadarIds?: string[]; completedSignalIds?: string[]; reuseAnalysis?: boolean; enrichEvidence?: boolean; signal?: AbortSignal; onProgress?: (progress: RadarProgress) => void | Promise<void>; onPartial?: (items: HotspotEvent[], analyzed: number, total: number, completedIds: string[]) => Promise<void> };
export type CollectedSource = { source: RadarSource; items: RadarSignal[]; error?: string; cacheStatus?: "fresh" | "validated" | "network" | "stale"; checkedAt: string };
export function safeSourceUrl(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("资讯链接必须是公开 HTTP(S) 地址");
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) throw new Error("资讯链接不能指向本机或内网");
  return url.toString();
}

export function canonicalRadarUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|spm)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
export function mergeRadarSignals(items: RadarSignal[]) {
  const kept: RadarSignal[] = [];
  for (const item of items) {
    const duplicate = kept.find(existing => canonicalRadarUrl(existing.url) === canonicalRadarUrl(item.url) || rules.sameHotspotEvent(existing, item) || rules.sameEvent(existing.title, item.title, existing.publishedAt, item.publishedAt));
    if (duplicate) duplicate.related = [...(duplicate.related || []), item];
    else kept.push({ ...item, related: [] });
  }
  return kept;
}
