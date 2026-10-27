"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import { useEffect, useState } from "react";
import { ArrowLeft, Columns3, LayoutGrid, Loader2, RefreshCw, Search, Settings2 } from "lucide-react";
import { useRadarController } from "./useRadarController";
import { RadarResults } from "./RadarResults";
import { RadarDetail } from "./RadarDetail";
import { radarCategories, radarDate as date } from "./radar-presentation";
import { radarGrades } from "@/lib/hotspot-radar/types";
import { TrendRadarCandidates } from "./TrendRadarCandidates";

type ExtraView = "none" | "sources" | "candidates" | "report";

export default function RadarAnalysis() {
  const c = useRadarController();
  const [settings, setSettings] = useState(false);
  const [extra, setExtra] = useState<ExtraView>("none");
  const [query, setQuery] = useState(c.search);
  useEffect(() => setQuery(c.search), [c.search]);
  const collection = c.snapshot?.collection;
  const scouts = c.snapshot?.scouts || [];
  const latestFailed = !c.active && c.latest?.status === "failed";
  const failure = collection?.error || (latestFailed ? c.latest?.error || c.latest?.message : "");
  const report = c.snapshot?.dailyReport;
  const busy = Boolean(c.active) || c.starting;
  const canContinue = Boolean(collection?.signalCount) && !(collection?.status === "completed" && c.snapshot?.analysis?.coverage === 100);
  const canRetryReport = Boolean(failure && collection && (collection.candidateCount > 0 || c.snapshot?.analysis) && collection.analyzedCount === collection.candidateCount);
  const filtered = Boolean(c.search || c.category || c.grade || c.source);
  const state = c.loading && !c.snapshot ? "正在读取" : c.active ? "正在更新" : failure ? "更新未完成" : collection?.status === "cancelled" ? "已停止" : c.provisional.length ? "部分结果" : "";

  function filter(key: string, value: string) { c.setFilter({ [key]: value, page: "", item: "" }); }
  function showExtra(next: ExtraView) { setExtra(value => value === next ? "none" : next); }

  return <div className="radar-analysis radar-analysis-simple">
    <div className="radar-main-toolbar" aria-label="选题工具栏">
      <form className="radar-quick-search" onSubmit={event => { event.preventDefault(); filter("q", query.trim()); }}>
        <label htmlFor="radar-search">搜索</label>
        <input id="radar-search" placeholder="标题、游戏或人物" value={query} onChange={event => setQuery(event.target.value)} />
        <button className="btn compact icon-btn" aria-label="搜索选题"><Search size={15} /></button>
      </form>
      {c.view === "topics" ? <label className="radar-inline-field" htmlFor="radar-category">分类<WorkbenchSelect aria-label="分类" id="radar-category" value={c.category} onValueChange={value => filter("category", value)}><option value="">全部分类</option>{radarCategories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</WorkbenchSelect></label> : <button className="btn compact" onClick={() => c.setFilter({ view: "topics", page: "", item: "" })}><ArrowLeft size={14} />返回选题</button>}
      <div className="radar-view-switch" role="group" aria-label="查看方式">
        <button className="btn compact" aria-pressed={c.layout === "cards"} onClick={() => c.setLayout("cards")}><LayoutGrid size={15} />卡片</button>
        <button className="btn compact" aria-pressed={c.layout === "overview"} onClick={() => c.setLayout("overview")}><Columns3 size={15} />分类总览</button>
      </div>
      <button className="btn compact icon-btn" aria-label="选题设置" title="筛选与更多操作" aria-expanded={settings} aria-controls="radar-settings" onClick={() => { setSettings(value => !value); setExtra("none"); }}><Settings2 size={16} /></button>
      <button className="btn compact primary" disabled={busy} aria-busy={busy} onClick={() => void c.refresh()}>{busy ? <Loader2 size={15} /> : <RefreshCw size={15} />}更新选题</button>
    </div>

    <div className="radar-brief" aria-live="polite">
      <span><strong>{c.view === "topics" ? c.topicCount : c.feed.total}</strong> {c.view === "topics" ? "个选题" : "条采集记录"}</span>
      <span>{c.snapshot?.generatedAt ? `更新于 ${date(c.snapshot.generatedAt)}` : "尚无完整更新"}</span>
      {scouts.some(item => item.error) ? <span className="radar-error-text">{scouts.filter(item => item.error).length} 个来源异常 · 设置中查看</span> : null}
      {state ? <span className={failure ? "radar-error-text" : ""}>{state}{c.provisional.length ? ` · ${c.provisional.length} 个本轮结果` : ""}</span> : null}
      {filtered ? <><span>当前显示 {c.view === "topics" ? c.topics.length : c.feed.total} 条</span><button className="btn compact" onClick={() => c.setFilter({ q: "", source: "", category: "", grade: "", page: "", item: "" })}>清除筛选</button></> : null}
    </div>

    {c.error ? <p className="error" role="alert">{c.error}</p> : null}
    {c.active ? <div className="radar-progress radar-inline-progress" role="status" aria-live="polite"><progress max={100} value={c.active.progress} aria-label="选题更新进度" /><span>{c.active.message}</span><button className="btn compact" onClick={() => void c.cancel()}>停止</button></div> : failure ? <div className="radar-inline-error" role="alert"><span>{failure} · 已保存的结果仍可查看。</span><button className="btn compact" disabled={busy} onClick={() => void c.refresh(canRetryReport, !canRetryReport && canContinue)}>{canRetryReport ? "重试日报" : canContinue ? "继续分析" : "重试更新"}</button></div> : null}

    {settings ? <section className="radar-settings" id="radar-settings" aria-label="选题设置">
      <div className="radar-settings-controls">
        <label className="radar-inline-field" htmlFor="radar-grade">优先级<WorkbenchSelect aria-label="优先级" id="radar-grade" value={c.grade} onValueChange={value => filter("grade", value)}><option value="">全部优先级</option>{radarGrades.map(grade => <option key={grade}>{grade}</option>)}</WorkbenchSelect></label>
        <label className="radar-inline-field" htmlFor="radar-source">来源<WorkbenchSelect aria-label="来源" id="radar-source" value={c.source} onValueChange={value => filter("source", value)}><option value="">全部来源</option>{scouts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</WorkbenchSelect></label>
        <label className="radar-inline-field" htmlFor="radar-sort">排序<WorkbenchSelect aria-label="排序" id="radar-sort" value={c.sort} onValueChange={value => filter("sort", value)}><option value="latest">最新优先</option><option value="priority">优先级最高</option></WorkbenchSelect></label>
      </div>
      <div className="radar-settings-actions">
        {canContinue ? <button className="btn compact" disabled={busy} onClick={() => void c.refresh(false, true)}>继续上轮分析</button> : null}
        <button className="btn compact" aria-expanded={extra === "sources"} onClick={() => showExtra("sources")}>来源状态</button>
        <button className="btn compact" aria-expanded={extra === "candidates"} onClick={() => showExtra("candidates")}>手动补充候选</button>
        {report ? <button className="btn compact" aria-expanded={extra === "report"} onClick={() => showExtra("report")}>查看日报</button> : null}
        <button className="btn compact" onClick={() => { c.setFilter({ view: c.view === "news" ? "topics" : "news", page: "", item: "", source: "", category: "", grade: "", q: "" }); setSettings(false); setExtra("none"); }}>{c.view === "news" ? "返回选题" : "采集记录"}</button>
      </div>
      {extra === "sources" ? <div className="radar-diagnostics"><p>{scouts.filter(item => item.lastCheckedAt && !item.error).length}/{scouts.length} 个来源可用{c.snapshot?.analysis ? ` · 精筛 ${c.snapshot.analysis.analyzedCount}/${c.snapshot.analysis.coarseCount} 条 · 复用 ${c.snapshot.analysis.reusedItemCount || 0} 条判断` : ""}</p><ul>{scouts.map(item => <li key={item.id}><strong>{item.name}</strong><span>{item.itemCount} 条</span><span className={item.error ? "radar-error-text" : "subtle"}>{item.error || (item.lastCheckedAt ? "采集完成" : "尚未采集")}{item.cacheStatus ? ` · ${{fresh: "缓存命中", validated: "来源未变化", network: "重新获取", stale: "旧缓存回退"}[item.cacheStatus]}` : ""}</span></li>)}</ul></div> : null}
      {extra === "candidates" ? <TrendRadarCandidates busy={busy} onAnalyze={ids => c.refresh(false, false, ids)} /> : null}
      {extra === "report" && report ? <article className="radar-report"><h2>{report.headline}</h2><p>{report.overview}</p><ul>{report.signals.map((item, i) => <li key={i}>{item}</li>)}</ul><p>{report.communityMood}</p><h3>后续关注</h3><ul>{report.tomorrowWatch.map((item, i) => <li key={i}>{item}</li>)}</ul></article> : null}
    </section> : null}

    <RadarResults c={c} />
    {c.selectedId ? <RadarDetail c={c} /> : null}
  </div>;
}
