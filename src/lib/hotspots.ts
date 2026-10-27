import { getRadarPipelineConfig } from "./hotspot-radar/config";
import { collectUnifiedSources, deduplicateUnifiedSignals } from "./hotspot-radar/unified-sources";
import { getTrendRadarFeed, selectTrendRadarSources } from "./trendradar";
import { readRadarCollection, writeRadarCollection, updateRadarCollection } from "./hotspot-radar/collection";
import path from "node:path";
import { libraryRoot } from "./storage/core";
import { readJsonFile, writeJsonFile } from "./storage/fs";
import { hotspotFeedbackSchema, hotspotSnapshotSchema } from "./storage/schemas";
import { withMutationLock } from "./storage/mutation-lock";
import { analyzeRadar, toStoredSignal } from "./hotspot-radar/analysis";
import { mergeRadarSignals } from "./hotspot-radar/collector";
import type { CollectedSource, RadarRefreshOptions } from "./hotspot-radar/collector";
import { isRecentVerifiedSignal, sameEvent } from "./hotspot-radar/source-rules.mjs";
import { radarGrades } from "./hotspot-radar/types";
import type { RadarFeedback, RadarRating } from "./hotspot-radar/types";
import type { HotspotEvent, HotspotRadarRefreshResult, HotspotRadarResponse, HotspotSignal } from "./types";

const queues = new Map<string, Promise<unknown>>();
const activeRefreshes = new Set<string>();
function snapshotPath() { return path.join(libraryRoot(), "hotspots", "radar-snapshot.json"); }
function feedbackPath() { return path.join(libraryRoot(), "hotspots", "radar-feedback.json"); }
async function readSnapshot(): Promise<HotspotRadarRefreshResult> {
  const saved = await readJsonFile<unknown>(snapshotPath());
  if (saved === null) return emptySnapshot();
  const result = hotspotSnapshotSchema.safeParse(saved);
  if (!result.success) throw new Error("热点雷达快照格式损坏，请备份并检查 hotspots/radar-snapshot.json；未覆盖原文件");
  return result.data;
}
async function readFeedback(): Promise<RadarFeedback> {
  const saved = await readJsonFile<unknown>(feedbackPath());
  if (saved === null) return { schemaVersion: 1, ratings: [], history: [] };
  const result = hotspotFeedbackSchema.safeParse(saved);
  if (!result.success) throw new Error("热点评分文件格式损坏，请检查 hotspots/radar-feedback.json；未覆盖原文件");
  return result.data;
}
export async function getHotspotRadar(options: { refresh?: boolean } & RadarRefreshOptions = {}): Promise<HotspotRadarRefreshResult> {
  if (options.refresh) return refreshHotspotRadar(options);
  const [snapshot, feedback] = await Promise.all([readSnapshot(), readFeedback()]);
  const response = summarizeSnapshot(applyFeedback(snapshot, feedback));
  const collection = await readRadarCollection();
  if (collection) {
    response.collection = { generatedAt: collection.generatedAt, signalCount: collection.signals.filter(item => !isVideoSignal(item)).length, status: collection.status, error: collection.error, analyzedCount: collection.analyzedCount, candidateCount: collection.candidateCount };
    response.scouts = collection.scouts.filter(item => item.id !== "video-hotlist");
    response.analysis = collection.analysis;
    if (collection.status !== "completed") response.provisionalHotspots = summarizeSnapshot(applyFeedback({ ...snapshot, hotspots: collection.partialHotspots, signals: [...snapshot.signals, ...collection.signals] }, feedback)).hotspots;
  }
  return response;
}
export async function getHotspotDetail(id: string) {
  const [snapshot, feedback] = await Promise.all([readSnapshot(), readFeedback()]);
  const collection = await readRadarCollection();
  const partial = collection?.status !== "completed" ? collection?.partialHotspots.find(item => item.id === id) : undefined;
  const hotspot = applyFeedback({ ...snapshot, hotspots: partial ? [partial] : snapshot.hotspots, signals: [...snapshot.signals, ...(partial ? collection!.signals : [])] }, feedback).hotspots.find(item => item.id === id);
  if (!hotspot) throw new Error("选题不存在或已过期，请刷新选题列表");
  const ids = new Set(hotspot.signalIds);
  return { hotspot, signals: [...new Map([...snapshot.signals, ...(partial ? collection!.signals : [])].map(item => [item.id, item])).values()].filter(item => ids.has(item.id)) };
}
export async function saveHotspotFeedback(id: string, rating: RadarRating) {
  return withMutationLock(queues, feedbackPath(), async () => {
    const [snapshot, feedback] = await Promise.all([readSnapshot(), readFeedback()]);
    const topic = snapshot.hotspots.find(item => item.id === id) || (await readRadarCollection())?.partialHotspots.find(item => item.id === id);
    if (!topic) throw new Error("选题不存在，请刷新后评分");
    const record = { hotspotId: id, title: topic.title, summary: topic.summary, rating, updatedAt: new Date().toISOString() };
    feedback.ratings = [...feedback.ratings.filter(item => item.hotspotId !== id), record].slice(-1000);
    feedback.history = [...feedback.history, { hotspotId: id, rating, updatedAt: record.updatedAt }].slice(-1000);
    await writeJsonFile(feedbackPath(), hotspotFeedbackSchema.parse(feedback));
    return getHotspotRadar();
  });
}
export function summarizeSnapshot(snapshot: HotspotRadarRefreshResult): HotspotRadarRefreshResult {
  return { ...snapshot, signals: [], hotspots: snapshot.hotspots.map(item => ({ ...item, evidence: [], research: [], playerFocus: [], angles: [], risks: [], accounts: [], timeline: undefined, displayInfo: { ...item.displayInfo, facts: [] } })) };
}
function applyFeedback(snapshot: HotspotRadarRefreshResult, feedback: RadarFeedback) {
  const sources = new Map(snapshot.signals.map(item => [item.id, item.sourceId]));
  const ratings = new Map(feedback.ratings.map(item => [item.hotspotId, item.rating]));
  const hotspots = snapshot.hotspots.filter(item => isVisibleTopic(item, snapshot)).map(item => {
    item = { ...item, sourceIds: [...new Set([...(item.sourceIds || []), ...item.signalIds.flatMap(id => sources.has(id) ? [sources.get(id)!] : [])])] };
    const rating = ratings.get(item.id);
    if (!rating) return item;
    const gradeLabel: HotspotEvent["gradeLabel"] = rating === "不行" ? "先看看" : rating;
    const score = 100 - radarGrades.indexOf(gradeLabel) * 20;
    const hasBody = item.status === "ready" || item.displayInfo.statusLine.includes("已取得正文");
    const status: HotspotEvent["status"] = item.status === "risk" ? "risk" : score >= 60 && hasBody ? "ready" : "watch";
    return { ...item, userRating: rating, gradeLabel, priorityLabel: gradeLabel, score, status, displayInfo: { ...item.displayInfo, statusLine: item.displayInfo.statusLine.replace(/^(吊爆了|有点东西|能做|还行|先看看)/, gradeLabel) } };
  });
  return { ...snapshot, ...(snapshot.hotspots.some(item => hasVideoEvidence(item, snapshot.signals)) ? { dailyReport: undefined } : {}), hotspots: sortTopics(hotspots), summary: { ...snapshot.summary, hotspotCount: hotspots.length, readyCount: hotspots.filter(item => item.status === "ready").length } };
}
function isVideoSignal(item: Pick<HotspotSignal, "id" | "sourceId" | "inputKind">) {
  return item.inputKind === "video" || item.sourceId === "video-hotlist" || item.id.startsWith("video:");
}
function hasVideoEvidence(item: HotspotEvent, signals: HotspotSignal[]) {
  return item.sourceIds?.includes("video-hotlist") || item.signalIds.some(id => id.startsWith("video:") || signals.some(signal => signal.id === id && isVideoSignal(signal)));
}
function isVisibleTopic(item: HotspotEvent, snapshot: HotspotRadarResponse) {
  if (hasVideoEvidence(item, snapshot.signals)) return false;
  if (item.retainedUntil && Date.parse(item.retainedUntil) > Date.now()) return true;
  if (item.updatedAt) return isRecentVerifiedSignal({ publishedAt: item.updatedAt });
  if (item.publishedAt) return isRecentVerifiedSignal(item);
  // 旧版选题没有日期时，至少按快照日期淘汰陈旧数据。
  return isRecentVerifiedSignal({ publishedAt: snapshot.generatedAt });
}
function sortTopics(items: HotspotEvent[]) { return items.slice().sort((a, b) => radarGrades.indexOf(a.gradeLabel || "先看看") - radarGrades.indexOf(b.gradeLabel || "先看看") || (b.publishedAt || "").localeCompare(a.publishedAt || "")); }
export function retainPriorityTopics(previous: HotspotRadarRefreshResult, current: HotspotEvent[], now = Date.now()) {
  previous = { ...previous, hotspots: previous.hotspots.filter(item => !hasVideoEvidence(item, previous.signals)) };
  current = current.filter(item => !hasVideoEvidence(item, previous.signals));
  const byId = new Map(previous.hotspots.map(item => [item.id, item]));
  const currentIds = new Set(current.map(item => item.id));
  const pool: HotspotEvent[] = current.map(item => {
    const old = byId.get(item.id) || previous.hotspots.find(candidate => sameEvent(candidate.title, item.title, candidate.publishedAt || "", item.publishedAt || ""));
    if (old) currentIds.add(old.id);
    const existingDeadline = old?.retainedUntil;
    // 保留时钟从首次进入最高档开始，不因每次刷新无限延长。
    const retainedUntil = item.gradeLabel === "吊爆了" ? existingDeadline || new Date(now + 72 * 3600000).toISOString() : undefined;
    const unchanged = Boolean(old?.eventFingerprint && old.eventFingerprint === item.eventFingerprint);
    const timeline = item.timeline ? [...new Map([...(old?.timeline || []), ...item.timeline].map(entry => [entry.signalId, entry])).values()].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || "")).slice(0, 30) : old?.timeline;
    return { ...item, ...(unchanged ? { updatedAt: old!.updatedAt, development: old!.development } : {}), timeline, retainedUntil, sourceIds: [...new Set([...(item.sourceIds || []), ...(old?.sourceIds || [])])], signalIds: [...new Set([...item.signalIds, ...(old?.signalIds || [])])], evidence: [...new Set(item.evidence)] };
  });
  for (const item of previous.hotspots) {
    if (!currentIds.has(item.id) && item.gradeLabel === "吊爆了" && item.retainedUntil && Date.parse(item.retainedUntil) > now) pool.push(item);
  }
  return sortTopics(pool);
}
export function assertCollectionCoverage(collected: CollectedSource[]) {
  const successful = collected.filter(item => !item.error || item.items.length > 0).length;
  if (successful < Math.ceil(collected.length / 2) || !collected.some(item => item.items.length)) {
    throw new Error(`热点采集覆盖不足（${successful}/${collected.length} 来源成功），已保留上次快照，请检查网络后重试。${collected.filter(item => item.error).slice(0, 4).map(item => `${item.source.name}：${item.error}`).join("；")}`);
  }
}
export async function refreshHotspotRadar(options: RadarRefreshOptions = {}): Promise<HotspotRadarRefreshResult> {
  const key = snapshotPath();
  if (activeRefreshes.has(key)) throw new Error("热点刷新任务正在运行，请到任务中心查看进度");
  activeRefreshes.add(key);
  const callerSignal = options.signal;
  const deadline = AbortSignal.timeout(570000);
  options = { ...options, signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline };
  let collectionSaved = false;
  try {
    const [previous, feedback] = await Promise.all([readSnapshot(), readFeedback()]);
    if (options.retryReport) return await finishSavedRadarReport(previous, feedback, options, callerSignal);
    const lastCollection = await readRadarCollection();
    const saved = options.continueAnalysis ? lastCollection : null;
    if (options.continueAnalysis && (!saved || !saved.signals.length || !Number.isFinite(Date.parse(saved.generatedAt)) || Date.now() - Date.parse(saved.generatedAt) > 72 * 3600000)) throw new Error("没有可继续分析的近期资讯，请重新采集");
    const unified = !saved || saved.pipeline === "unified-events";
    if (unified) options = { ...options, pipeline: getRadarPipelineConfig(), previousTopics: previous.hotspots.filter(item => isVisibleTopic(item, previous)) };
    if (saved && (saved.signals.some(isVideoSignal) || saved.partialHotspots.some(item => hasVideoEvidence(item, saved.signals)))) throw new Error("旧采集批次包含已停用的视频热榜，请点击更新选题重新采集，不能继续此批次");
    const restoredTopics = saved ? (saved.status === "completed" ? previous.hotspots.filter(item => isVisibleTopic(item, previous)) : saved.partialHotspots) : [];
    // 工作台完成状态独立于 TrendRadar 的本轮新增标记。仅沿用已发布成功的近期批次，
    // 未完成批次仍走逐条模型缓存，避免跳过尚未发布的选题。
    const reusable = !saved && unified && lastCollection?.status === "completed" && Date.now() - Date.parse(lastCollection.generatedAt) <= 72 * 3600000;
    const restoredIds = saved?.completedSignalIds || (reusable ? lastCollection.completedSignalIds : undefined) || restoredTopics.flatMap(item => item.signalIds);
    const collected: CollectedSource[] = saved ? saved.scouts.map(scout => ({
      source: { id: scout.id, name: scout.name, url: scout.sources[0] || "", scope: scout.scope, type: "saved" },
      checkedAt: scout.lastCheckedAt || saved.generatedAt, error: scout.error, cacheStatus: scout.cacheStatus,
      items: saved.signals.filter(item => item.sourceId === scout.id).map(item => ({ id: item.id, sourceId: item.sourceId, source: item.sourceName, originalSource: item.sourceName, title: item.title, summary: item.summary || "", url: item.url || "", category: item.category, publishedAt: item.publishedAt || "", collectedAt: item.capturedAt, inputKind: item.inputKind, observedAt: item.observedAt, metrics: item.metrics }))
    })) : options.trendRadarIds ? selectTrendRadarSources(await getTrendRadarFeed(options.signal), options.trendRadarIds) : await collectUnifiedSources(options.pipeline!, options);
    options.signal?.throwIfAborted();
    const collectedAt = saved?.generatedAt || new Date().toISOString();
    if (!saved) await writeRadarCollection({ ...(unified ? { pipeline: "unified-events" as const } : {}), schemaVersion: 1, generatedAt: collectedAt, signals: collected.flatMap(item => item.items).map(toStoredSignal), scouts: collected.map(item => ({ id: item.source.id, board: "game", name: item.source.name, scope: item.source.scope, cadence: "手动刷新", sources: [item.source.url], status: item.error ? "failed" : "running", coverage: item.error ? 0 : 100, itemCount: item.items.length, lastCheckedAt: item.checkedAt, cacheStatus: item.cacheStatus, error: item.error })), status: "collected", partialHotspots: [], analyzedCount: 0, candidateCount: 0 });
    collectionSaved = true;
    await options.onProgress?.({ completed: collected.length, total: collected.length, sourceName: saved ? "沿用已保存资讯，继续未完成候选" : "资讯已保存，可立即阅读", failed: false, stage: "collect", dataChanged: true });
    assertCollectionCoverage(collected);
    await updateRadarCollection(current => ({ ...current, status: "analyzing", error: undefined, partialHotspots: restoredTopics }));
    const merged = unified ? deduplicateUnifiedSignals(collected.flatMap(item => item.items)) : mergeRadarSignals(collected.flatMap(item => item.items));
    const analyzed = await analyzeRadar(merged, feedback, { reuseAnalysis: true, enrichEvidence: true, ...options, completedSignalIds: restoredIds, async onPartial(items, count, total, completedIds) {
      options.signal?.throwIfAborted();
      await updateRadarCollection(current => ({ ...current, partialHotspots: [...restoredTopics, ...items], completedSignalIds: completedIds, analyzedCount: count, candidateCount: total }));
      await options.onProgress?.({ completed: count, total, sourceName: `已保存 ${items.length} 个选题，正在继续分析`, failed: false, stage: "AI 精筛", dataChanged: true });
    } });
    await updateRadarCollection(current => ({ ...current, analysis: analyzed.analysis, completedSignalIds: analyzed.completedSignalIds }));
    const keepExisting = unified || Boolean(options.trendRadarIds) || Boolean(saved?.scouts.some(scout => scout.id.startsWith("trend:")));
    const hotspots = retainPriorityTopics(previous, [...new Map([...(keepExisting ? previous.hotspots.filter(item => isVisibleTopic(item, previous)) : []), ...restoredTopics, ...analyzed.hotspots].map(item => [item.id, item])).values()]);
    const sourceSignals = merged.flatMap(item => [item, ...(item.related || [])]).map(toStoredSignal);
    const signalsById = new Map<string, HotspotSignal>(sourceSignals.map(item => [item.id, item]));
    for (const hotspot of hotspots) for (const id of hotspot.signalIds) {
      if (!signalsById.has(id)) { const signal = previous.signals.find(item => item.id === id); if (signal) signalsById.set(id, signal); }
    }
    const generatedAt = new Date().toISOString();
    const successful = collected.filter(item => !item.error).length;
    const counts = { sourceCount: collected.length, completedSourceCount: successful, failedSourceCount: collected.length - successful, signalCount: merged.length, hotspotCount: hotspots.length, readyCount: hotspots.filter(item => item.status === "ready").length, averageScore: 0 };
    const snapshot: HotspotRadarRefreshResult = {
      schemaVersion: 1, generatedAt, hotspots, signals: [...signalsById.values()], analysis: analyzed.analysis,
      scouts: collected.map(item => ({ id: item.source.id, board: "game", name: item.source.name, scope: item.source.scope, cadence: "手动任务刷新", sources: [item.source.url], status: item.error ? "failed" : item.items.length ? "running" : "paused", coverage: item.error ? 0 : 100, itemCount: item.items.length, lastCheckedAt: item.checkedAt, cacheStatus: item.cacheStatus, error: item.error })),
      summary: { ...counts, generatedAt, boardStats: [{ ...counts, board: "game", topScore: 0 }] },
      refresh: { requested: collected.length, completed: successful, failed: collected.length - successful, sources: collected.map(item => ({ id: item.source.id, board: "game", name: item.source.name, status: item.error ? "failed" : "completed", itemCount: item.items.length, error: item.error })) }
    };
    const latestFeedback = await readFeedback();
    options.signal?.throwIfAborted();
    await updateRadarCollection(current => ({ ...current, partialHotspots: hotspots }));
    await publishRadarSnapshot(snapshot, () => analyzed.report(hotspots), options);
    await updateRadarCollection(current => ({ ...current, status: "completed", error: undefined, partialHotspots: [], analyzedCount: analyzed.analysis.analyzedCount, candidateCount: analyzed.analysis.coarseCount }));
    return summarizeSnapshot(applyFeedback(snapshot, latestFeedback));
  } catch (error) {
    const failure = deadline.aborted && !callerSignal?.aborted ? new Error("本轮已达到 9 分半时间上限，已保留采集资讯与完成选题；再次刷新会复用有效分析缓存") : error;
    if (collectionSaved) {
      await updateRadarCollection(current => ({ ...current, status: callerSignal?.aborted ? "cancelled" : "failed", error: callerSignal?.aborted ? "任务已取消，已采集资讯仍可阅读" : failure instanceof Error ? failure.message : "热点分析失败，请重试" }));
      await options.onProgress?.({ completed: 0, total: 1, sourceName: "已保留采集结果和完成批次", failed: true, stage: "保存诊断", dataChanged: true });
    }
    throw failure;
  } finally { activeRefreshes.delete(key); }
}
// 日报是独立产物：先保存可使用的选题，再调用日报模型；失败不得回滚选题。
export async function publishRadarSnapshot(snapshot: HotspotRadarRefreshResult, report: () => Promise<HotspotRadarRefreshResult["dailyReport"]>, options: RadarRefreshOptions) {
  options.signal?.throwIfAborted();
  await writeJsonFile(snapshotPath(), hotspotSnapshotSchema.parse({ ...snapshot, dailyReport: undefined }));
  await options.onProgress?.({ completed: 0, total: 1, sourceName: "选题已发布，正在生成日报", failed: false, stage: "日报", dataChanged: true });
  try {
    snapshot.dailyReport = await report();
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new Error(`选题已保存，日报生成失败，可仅重试日报。${error instanceof Error ? error.message : "请检查模型配置"}`, { cause: error });
  }
  options.signal?.throwIfAborted();
  await writeJsonFile(snapshotPath(), hotspotSnapshotSchema.parse(snapshot));
}
function emptySnapshot(): HotspotRadarRefreshResult {
  return { schemaVersion: 1, generatedAt: "", hotspots: [], signals: [], scouts: [], summary: { sourceCount: 0, completedSourceCount: 0, failedSourceCount: 0, signalCount: 0, hotspotCount: 0, readyCount: 0, averageScore: 0, boardStats: [], generatedAt: "" }, refresh: { requested: 0, completed: 0, failed: 0, sources: [] } };
}
export function getHotspotRadarSnapshotSummary(snapshot: HotspotRadarResponse) {
  return `${snapshot.summary.completedSourceCount}/${snapshot.summary.sourceCount} 个源可用，${snapshot.summary.signalCount} 条信号，${snapshot.summary.hotspotCount} 个选题。`;
}

export async function getRadarSignals(query: { page?: number; search?: string; source?: string; id?: string } = {}) {
  const collection = await readRadarCollection();
  const snapshot = collection ? null : await readSnapshot();
  const all = (collection?.signals || snapshot?.signals || []).filter(item => !isVideoSignal(item));
  const matching = [...all].sort((a, b) => Date.parse(b.publishedAt || b.capturedAt) - Date.parse(a.publishedAt || a.capturedAt)).filter(item => (!query.id || item.id === query.id) && (!query.source || item.sourceId === query.source) && (!query.search || `${item.title} ${item.sourceName} ${item.summary || ""}`.toLowerCase().includes(query.search.toLowerCase())));
  const page = Math.min(Math.max(1, Math.floor(query.page || 1)), Math.max(1, Math.ceil(matching.length / 30)));
  const items: HotspotSignal[] = query.id ? matching : matching.slice((page - 1) * 30, page * 30).map(({ summary: _summary, ...item }) => { void _summary; return item; });
  return { items, total: matching.length, page, generatedAt: collection?.generatedAt || snapshot?.generatedAt || "" };
}


async function finishSavedRadarReport(previous: HotspotRadarRefreshResult, feedback: RadarFeedback, options: RadarRefreshOptions, callerSignal?: AbortSignal) {
  const collection = await readRadarCollection();
  if (!collection || (!collection.analysis && !collection.candidateCount) || collection.analyzedCount !== collection.candidateCount || !["failed", "cancelled"].includes(collection.status)) throw new Error("没有已完成精筛且待恢复的日报，请重新采集并筛选");
  if (Date.now() - Date.parse(collection.generatedAt) > 72 * 3600000) throw new Error("已保存资讯超过72小时，请重新采集");
  if (collection.signals.some(isVideoSignal) || collection.partialHotspots.some(item => hasVideoEvidence(item, collection.signals))) throw new Error("旧日报批次包含已停用的视频热榜，请点击更新选题重新采集");
  try {
  await updateRadarCollection(current => ({ ...current, status: "analyzing", error: undefined }));
  const hotspots = retainPriorityTopics(previous, collection.partialHotspots);
  await options.onProgress?.({ completed: 0, total: 1, sourceName: "恢复已完成选题，仅重新生成日报", failed: false, stage: "日报", dataChanged: true });
  const reportRunner = await analyzeRadar([], feedback, options);
  const dailyReport = await reportRunner.report(hotspots);
  const generatedAt = new Date().toISOString();
  const successful = collection.scouts.filter(item => !item.error).length;
  const counts = { sourceCount: collection.scouts.length, completedSourceCount: successful, failedSourceCount: collection.scouts.length - successful, signalCount: collection.signals.length, hotspotCount: hotspots.length, readyCount: hotspots.filter(item => item.status === "ready").length, averageScore: 0 };
  const signals = new Map(collection.signals.map(item => [item.id, item]));
  for (const topic of hotspots) for (const id of topic.signalIds) if (!signals.has(id)) { const item = previous.signals.find(signal => signal.id === id); if (item) signals.set(id, item); }
  const analysis = collection.analysis ? { ...collection.analysis, fallback: collection.analysis.fallback || reportRunner.analysis.fallback, fallbackReason: [collection.analysis.fallbackReason, reportRunner.analysis.fallbackReason].filter(Boolean).join("；") || undefined } : undefined;
  const snapshot: HotspotRadarRefreshResult = { schemaVersion: 1, generatedAt, hotspots, signals: [...signals.values()], scouts: collection.scouts, dailyReport, analysis,
    summary: { ...counts, generatedAt, boardStats: [{ ...counts, board: "game", topScore: 0 }] },
    refresh: { requested: counts.sourceCount, completed: successful, failed: counts.failedSourceCount, sources: collection.scouts.map(item => ({ id: item.id, board: "game", name: item.name, status: item.error ? "failed" : "completed", itemCount: item.itemCount, error: item.error })) }
  };
  options.signal?.throwIfAborted();
  await writeJsonFile(snapshotPath(), hotspotSnapshotSchema.parse(snapshot));
  await updateRadarCollection(current => ({ ...current, status: "completed", error: undefined, partialHotspots: [] }));
  return summarizeSnapshot(applyFeedback(snapshot, await readFeedback()));
  } catch (error) {
    await updateRadarCollection(current => ({ ...current, status: callerSignal?.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : "日报生成失败，请重试" }));
    await options.onProgress?.({ completed: 0, total: 1, sourceName: "日报失败，已保留完成的选题", failed: true, stage: "日报", dataChanged: true });
    throw error;
  }
}
