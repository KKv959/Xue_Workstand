"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useScopedTasks } from "@/components/TaskProvider";
import { getCachedHotspotRadar, getHotspotRadar, getHotspotDetail, getRadarSignals, saveHotspotFeedback } from "@/lib/client";
import type { HotspotEvent, HotspotRadarResponse, HotspotSignal } from "@/lib/types";
import { radarGrades } from "@/lib/hotspot-radar/types";
import type { RadarRating } from "@/lib/hotspot-radar/types";

export function useRadarController() {
  const tasks = useScopedTasks({ href: "/hotspots", kinds: ["hotspot-refresh"] });
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = params.get("view") === "news" ? "news" : "topics";
  const [preferredLayout, setPreferredLayout] = useState<"cards" | "overview">("cards");
  const requestedLayout = params.get("layout");
  const layout = requestedLayout === "cards" || requestedLayout === "overview" ? requestedLayout : preferredLayout;
  const grade = params.get("grade") || "";
  const sort = params.get("sort") === "priority" ? "priority" : "latest";
  useEffect(() => {
    try { const saved = localStorage.getItem("hotspot-layout-v1"); if (saved === "cards" || saved === "overview") setPreferredLayout(saved); }
    catch { /* 视图偏好属于可选设置，浏览器禁用存储时仍使用 URL。 */ }
  }, []);
  const search = params.get("q") || "";
  const source = params.get("source") || "";
  const category = params.get("category") || "";
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const selectedId = params.get("item") || "";
  const [snapshot, setSnapshot] = useState<HotspotRadarResponse | null>(getCachedHotspotRadar);
  const [feed, setFeed] = useState<{ items: HotspotSignal[]; total: number }>({ items: [], total: 0 });
  const [detail, setDetail] = useState<{ topic?: HotspotEvent; signals: HotspotSignal[] } | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(() => !getCachedHotspotRadar() || view === "news");
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const detailSequence = useRef(0);
  const active = tasks.activeJobs[0];
  const latest = tasks.recentJobs[0];
  const job = active || latest;
  const jobKey = job ? `${job.id}:${job.dataRevision || 0}:${job.status}` : "";
  const previousJobKey = useRef("");
  const setFilter = useCallback((values: Record<string, string>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    router.replace(`${pathname}?${next}`, { scroll: false });
  }, [pathname, router]);
  function setLayout(next: "cards" | "overview", filters: Record<string, string> = {}) {
    setPreferredLayout(next);
    try { localStorage.setItem("hotspot-layout-v1", next); }
    catch { /* 视图偏好写入失败不影响 URL 中的选择。 */ }
    setFilter({ layout: next, ...filters });
  }
  useEffect(() => {
    if (!jobKey || jobKey === previousJobKey.current) return;
    previousJobKey.current = jobKey;
    // TaskProvider invalidates changed data; remounting with the same job can reuse the snapshot.
    setRevision(value => value + 1);
  }, [jobKey]);
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    Promise.all([getHotspotRadar(), view === "news" ? getRadarSignals({ page, search, source }) : Promise.resolve({ items: [], total: 0 })]).then(([radar, articles]) => {
      if (ignore) return;
      setSnapshot(radar); setFeed(articles); setError("");
      if (view === "news" && "page" in articles && articles.page !== page) setFilter({ page: String(articles.page) });
    }).catch(error => { if (!ignore) setError(message(error)); }).finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [page, search, source, revision, view, setFilter]);
  useEffect(() => {
    const sequence = ++detailSequence.current;
    setDetail(null); setDetailError(""); setNotice("");
    if (!selectedId) { setDetailLoading(false); return; }
    setDetailLoading(true);
    const request = view === "topics" ? getHotspotDetail(selectedId).then(result => ({ topic: result.hotspot, signals: result.signals })) : getRadarSignals({ id: selectedId }).then(result => {
      if (!result.items.length) throw new Error("这条资讯已不在当前采集结果中，请重新选择");
      return { signals: result.items };
    });
    request.then(result => { if (sequence === detailSequence.current) setDetail(result); })
      .catch(error => { if (sequence === detailSequence.current) setDetailError(message(error)); })
      .finally(() => { if (sequence === detailSequence.current) setDetailLoading(false); });
    return () => { detailSequence.current += 1; };
  }, [selectedId, view, revision]);
  async function refresh(retryReport = false, continueAnalysis = false, trendRadarIds?: string[]) {
    setStarting(true); setError("");
    try { await tasks.startTask({ kind: "hotspot-refresh", href: "/hotspots?view=topics", input: { retryReport, continueAnalysis, trendRadarIds } }); }
    catch (error) { setError(message(error)); }
    finally { setStarting(false); }
  }
  async function cancel() { if (active) { try { await tasks.cancelTask(active.id); } catch (error) { setError(message(error)); } } }
  async function rate(rating: RadarRating) {
    if (!detail?.topic) return;
    const sequence = detailSequence.current;
    setSaving(true);
    try {
      const updated = await saveHotspotFeedback(detail.topic.id, rating);
      setSnapshot(updated);
      const updatedDetail = await getHotspotDetail(detail.topic.id);
      if (sequence === detailSequence.current) {
        setDetail({ topic: updatedDetail.hotspot, signals: updatedDetail.signals });
        setNotice(`已保存“${rating}”，后续选题会参考`);
      }
    } catch (error) { if (sequence === detailSequence.current) setDetailError(message(error)); }
    finally { setSaving(false); }
  }
  function write() {
    if (!detail) return;
    const topic = detail.topic;
    const text = [topic?.title || detail.signals[0]?.title, topic?.summary || detail.signals[0]?.summary, topic ? `编辑判断：${topic.whyNow}\n视频切入点：${topic.entryPoint || ""}` : "以下为采集资讯，尚未经 AI 筛选，请核实原文。", topic?.risks.length ? `待核实事项：${topic.risks.join("；")}` : "", topic?.evidence.length ? `采集材料（未经独立核实）：${topic.evidence.slice(0, 2).join("\n").slice(0, 2600)}` : "", ...detail.signals.map(item => `${item.sourceName}：${item.url || item.title}`)].filter(Boolean).join("\n\n");
    router.push(`/writer?${new URLSearchParams({ sourceText: text, prompt: "基于原始来源创作，区分已核实事实与编辑推断。" })}`);
  }
  const provisional = snapshot?.provisionalHotspots || [];
  const allTopics = [...provisional, ...(snapshot?.hotspots || []).filter(item => !provisional.some(partial => partial.id === item.id))];
  const topics = allTopics.filter(item => (!category || item.monitorType === category)
    && (!grade || item.gradeLabel === grade)
    && (!source || item.sourceIds?.includes(source))
    && (!search || `${item.title} ${item.summary} ${item.displayInfo.sourceLine}`.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (sort === "priority" ? radarGrades.indexOf(a.gradeLabel || "先看看") - radarGrades.indexOf(b.gradeLabel || "先看看") : 0) || (b.publishedAt || b.freshness).localeCompare(a.publishedAt || a.freshness));

  return { layout, setLayout, grade, sort, topicCount: allTopics.length, snapshot, feed, detail, error, detailError, loading, detailLoading, saving, starting, notice, active, latest, view, search, source, category, page, selectedId, topics, provisional, setFilter, refresh, cancel, rate, write };
}
function message(error: unknown) { return error instanceof Error ? error.message : "热点雷达操作失败，请重试"; }

export type RadarController = ReturnType<typeof useRadarController>;
