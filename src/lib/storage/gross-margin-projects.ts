import path from "path";
import { getGrossMarginProjectMonth, parseWecomProjectSheet } from "../gross-margin-projects";
import { fetchWecomSheetContent } from "../wecom-account-source";
import { shortHash } from "../utils";
import type { GrossMarginProjectSource } from "../types";
import { libraryRoot, normalizeStorageSegment } from "./core";
import { readJsonFile, writeJsonFile } from "./fs";
import { parseStoredRecord, versionStoredRecord } from "./schemas";

const defaultProjectSheetUrl = "https://doc.weixin.qq.com/sheet/e3_AZAA8QaHAAg6TaNa0YvQVyENOHn13?scode=ABQA4wclAAsf9prvNyAFQA1AYcAE4";
const syncQueues = new Map<string, Promise<unknown>>();

function sourceUrl() { return process.env.WECOM_PROJECT_SHEET_URL?.trim() || defaultProjectSheetUrl; }
function cachePath(month: string, url: string) {
  return path.join(libraryRoot(), "gross-margin", "project-orders", normalizeStorageSegment(`${month}-${shortHash(url)}.json`, "项目报价缓存"));
}

export async function getGrossMarginProjectSource(): Promise<GrossMarginProjectSource> {
  const month = getGrossMarginProjectMonth();
  const target = cachePath(month, sourceUrl());
  const raw = await readJsonFile<unknown>(target);
  if (raw === null) return { month, orders: [], stale: true };
  const cached = parseStoredRecord<GrossMarginProjectSource>(target, raw, "gross-margin-project-cache");
  if (cached.month !== month) throw new Error("项目报价缓存月份不一致，请重新同步当月项目表。");
  return { ...cached, stale: !cached.fetchedAt || Date.now() - Date.parse(cached.fetchedAt) >= 5 * 60 * 1000 };
}

export async function syncGrossMarginProjectSource(options: { signal?: AbortSignal; onProgress: (attempt: number) => Promise<void> }) {
  const month = getGrossMarginProjectMonth();
  const url = sourceUrl();
  const target = cachePath(month, url);
  const previous = syncQueues.get(target) || Promise.resolve();
  const next = previous.catch(() => {
    // 前一同步失败不能阻止后续重试；原调用方仍会收到失败。
  }).then(async () => {
    options.signal?.throwIfAborted();
    const content = await fetchWecomSheetContent(url, options);
    const orders = parseWecomProjectSheet(content, month);
    const result: GrossMarginProjectSource = { month, orders, fetchedAt: new Date().toISOString(), stale: false };
    options.signal?.throwIfAborted();
    const versioned = versionStoredRecord(result);
    parseStoredRecord(target, versioned, "gross-margin-project-cache");
    await writeJsonFile(target, versioned);
    return result;
  });
  syncQueues.set(target, next);
  try { return await next; }
  finally { if (syncQueues.get(target) === next) syncQueues.delete(target); }
}
