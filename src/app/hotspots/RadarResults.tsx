"use client";
import { ArrowRight, ChevronLeft, ChevronRight, Loader2, Newspaper } from "lucide-react";
import type { RadarController } from "./useRadarController";
import { isTopic, radarCategories, radarDate, radarSource, type RadarItem } from "./radar-presentation";

export function RadarResults({ c }: { c: RadarController }) {
  const pageSize = c.view === "topics" ? 12 : 30;
  const total = c.view === "topics" ? c.topics.length : c.feed.total;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(c.page, pageCount);
  const items = c.view === "topics" ? c.topics.slice((page - 1) * pageSize, page * pageSize) : c.feed.items;
  const groups = c.view === "topics"
    ? radarCategories.map(category => ({ ...category, items: c.topics.filter(item => item.monitorType === category.id) }))
    : (c.snapshot?.scouts || []).map(source => ({ id: source.id, label: source.name, items: c.feed.items.filter(item => item.sourceId === source.id) }));
  const showPagination = c.layout === "cards" || c.view === "news";
  return <section className="radar-results" aria-label={c.view === "topics" ? "AI 选题" : "全部资讯"} aria-busy={c.loading}>
    <div className="radar-results-heading">{c.view === "news" ? <span>{total} 条资讯{c.layout === "overview" ? " · 按来源展示本页资讯" : ""}</span> : null}<span className="subtle">{c.view === "topics" ? "优先级为编辑判断，不代表客观热度" : "原始资讯，尚未经事实核验"}</span></div>
    {c.loading && !total ? <div className="radar-empty" role="status"><Loader2 size={24} /><p>正在读取内容…</p></div> : null}
    {!c.loading && !total ? <div className="radar-empty"><Newspaper size={30} /><h3>{c.search || c.source || c.category || c.grade ? "没有匹配的内容" : "选题尚未就绪"}</h3><p>可以调整筛选，或先查看已经采集的原始资讯。</p><button className="btn" onClick={() => c.setFilter({ view: "news", source: "", category: "", grade: "", q: "", page: "", item: "" })}>查看全部资讯</button></div> : null}
    {c.layout === "cards" ? <div className="radar-card-grid">{items.map(item => <StoryCard key={item.id} item={item} partial={c.provisional.some(p => p.id === item.id)} onOpen={() => c.setFilter({ item: item.id })} />)}</div>
      : <div className="radar-overview-grid">{groups.filter(group => group.items.length).map(group => <section className="panel radar-group" key={group.id}>
        <header><h2>{group.label}</h2><span>{group.items.length} {c.view === "topics" ? "个选题" : "条 · 本页"}</span><button className="btn compact" onClick={() => c.setLayout("cards", { [c.view === "topics" ? "category" : "source"]: group.id, page: "", item: "" })} aria-label={`查看全部${group.label}`}>查看全部<ArrowRight size={14} /></button></header>
        <ol>{group.items.slice(0, 3).map((item, index) => <li key={item.id}><button onClick={() => c.setFilter({ item: item.id })} className="radar-group-story"><span className="radar-row-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{item.title}</strong><span className="radar-row-meta">{isTopic(item) ? `${item.gradeLabel || "待复核"} · ` : ""}{radarSource(item)} · {radarDate(item.publishedAt)}{c.provisional.some(p => p.id === item.id) ? " · 本轮部分结果" : ""}</span></span></button></li>)}</ol>
      </section>)}</div>}
    {total > 0 && showPagination ? <footer className="radar-pagination"><span>第 {page} / {pageCount} 页</span><div><button className="btn compact" disabled={page <= 1 || c.loading} onClick={() => c.setFilter({ page: String(page - 1) })}><ChevronLeft size={15} />上一页</button><button className="btn compact" disabled={page >= pageCount || c.loading} onClick={() => c.setFilter({ page: String(page + 1) })}>下一页<ChevronRight size={15} /></button></div></footer> : null}
  </section>;
}
function StoryCard({ item, partial, onOpen }: { item: RadarItem; partial: boolean; onOpen: () => void }) {
  const topic = isTopic(item);
  return <button className="panel radar-topic-card" onClick={onOpen} aria-label={`查看详情：${item.title}`}>
    <span className="radar-card-meta"><span className={`status-pill ${topic && item.score >= 80 ? "radar-priority-high" : ""}`}>{topic ? item.gradeLabel || "待复核" : "资讯"}</span><span>{topic ? item.monitorLabel : item.sourceName}{topic && item.development ? " · 有新进展" : ""}{topic && item.sources > 1 ? ` · ${item.sources} 条来源` : ""}</span></span>
    <strong className="radar-card-title">{item.title}</strong>
    {topic ? <span className="subtle">{item.displayInfo.statusLine.includes("正文") ? item.displayInfo.statusLine : "证据状态待复核"}</span> : null}
    {topic ? <><span className="radar-card-summary">{item.summary}</span>{item.whyNow ? <span className="radar-card-angle">{item.whyNow}</span> : null}</> : <span className="radar-card-summary">点击查看来源摘要与原文</span>}
    {partial ? <span className="radar-partial">本轮已完成 · 非完整结果</span> : null}
    <span className="radar-card-footer"><span title={radarSource(item)}>{radarSource(item)}<time>{radarDate(item.publishedAt)}</time></span><span>查看详情<ArrowRight size={13} /></span></span>
  </button>;
}
