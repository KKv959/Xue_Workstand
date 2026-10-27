"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Rss, Sparkles } from "lucide-react";
import { getTrendRadarFeed } from "@/lib/client";
import type { TrendRadarFeed } from "@/lib/trendradar-types";

export function TrendRadarCandidates({ busy, onAnalyze }: { busy: boolean; onAnalyze: (ids: string[]) => Promise<void> }) {
  const [feed, setFeed] = useState<TrendRadarFeed | null>(null);
  const [scope, setScope] = useState("all");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    getTrendRadarFeed(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setFeed(result);
      setSelected(current => current.filter(id => result.items.some(item => item.id === id)));
      setPage(0);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取 TrendRadar 失败");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  const filtered = (feed?.items || []).filter(item => (scope === "all" || item.isNew) && (kind === "all" || item.kind === kind) && `${item.title} ${item.source}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 12, (currentPage + 1) * 12);

  return <section className="trend-candidates" aria-label="TrendRadar 候选" aria-busy={loading}>
    <div className="trend-candidates-head">
      <div><h2><Rss size={16} />待分析资讯 <small>TrendRadar</small></h2><p>选中候选后交给 AI 筛选，每次最多 24 条。新增指来源最近一轮采集首次发现。</p></div>
      <div className="radar-header-actions">
        <button className="btn compact icon-btn" disabled={loading} aria-label="重新读取 TrendRadar 候选" title="重新读取本地结果，不触发上游抓取" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /></button>
        <button className="btn compact primary" disabled={busy || loading || Boolean(error) || !selected.length} onClick={() => void onAnalyze(selected)}><Sparkles size={14} />分析所选{selected.length ? `（${selected.length}）` : ""}</button>
      </div>
    </div>
    <div className="trend-candidates-meta">
      <label>范围<WorkbenchSelect aria-label="候选范围" value={scope} onValueChange={value => { setScope(value); setPage(0); }}><option value="all">全部候选</option><option value="new">本轮新增</option></WorkbenchSelect></label>
      <label>类型<WorkbenchSelect aria-label="候选类型" value={kind} onValueChange={value => { setKind(value); setPage(0); }}><option value="all">热榜与 RSS</option><option value="hotlist">热榜</option><option value="rss">RSS</option></WorkbenchSelect></label>
      <label className="trend-candidate-search">搜索<input value={query} placeholder="标题或来源" onChange={e => { setQuery(e.target.value); setPage(0); }} /></label>
      {feed ? <span>{feed.counts.hotlist} 条热榜 · {feed.counts.rss} 条 RSS · 本轮新增 {feed.counts.newItems} 条{feed.generatedAt ? ` · 最近采集 ${feed.generatedAt}（北京时间）` : ""}</span> : null}
    </div>
    <div aria-live="polite">
      {error ? <p className="error" role="alert">{error}。请检查本地 TrendRadar 服务后重试。</p> : loading ? <p>正在读取候选…</p> : !feed?.available ? <p>尚无本地采集结果，请先运行 TrendRadar。</p> : null}
      {feed?.missing.length ? <p>{feed.missing.join("、")}尚未生成，其余结果仍可查看。</p> : null}
      {feed?.warnings.map(warning => <p key={warning}>{warning}</p>)}
    </div>
    {!loading && !error ? <>
      <div className="trend-candidate-list">{visible.map(item => <div className="trend-candidate-row" key={item.id}>
        <input type="checkbox" aria-label={`选择 ${item.title}`} checked={selected.includes(item.id)} disabled={busy || (selected.length >= 24 && !selected.includes(item.id))} onChange={e => setSelected(current => e.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
        <a href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong><small>{item.source} · {item.kind === "rss" ? "RSS" : `热榜${item.rank ? ` #${item.rank}` : ""}`}{item.isNew ? " · 本轮新增" : ""}{item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : " · 发布时间待核实"}</small><ExternalLink size={12} /></a>
      </div>)}</div>
      {!visible.length && feed?.available ? <p>当前筛选没有候选，可切换到全部候选。</p> : null}
      <div className="trend-candidate-pagination"><span>{filtered.length} 条候选 · {currentPage + 1}/{pages} 页</span><button className="btn compact" disabled={!selected.length || busy} onClick={() => setSelected([])}>清空选择</button><button className="btn compact" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button className="btn compact" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
    </> : null}
  </section>;
}
