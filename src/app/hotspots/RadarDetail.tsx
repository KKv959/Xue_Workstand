"use client";
import { useRef } from "react";
import { ArrowRight, Check, ExternalLink, Loader2, X } from "lucide-react";
import { ModalBackdrop } from "@/components/ModalBackdrop";
import type { RadarController } from "./useRadarController";
import { radarDate as date } from "./radar-presentation";

export function RadarDetail({ c }: { c: RadarController }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const topic = c.detail?.topic;
  const article = c.detail?.signals[0];
  const title = topic?.title || article?.title;
  return <ModalBackdrop
    onClose={() => c.setFilter({ item: "" })}
    initialFocusRef={closeRef}
    className="radar-reader radar-drawer"
    aria-labelledby="radar-detail-label"
    aria-busy={c.detailLoading}
  >
      <header><h2 id="radar-detail-label">{c.view === "topics" ? "选题笔记" : "资讯预览"}</h2><button ref={closeRef} className="btn icon-btn" aria-label="关闭阅读详情" onClick={() => c.setFilter({ item: "" })}><X size={17} /></button></header>
        {c.detailLoading ? <div className="radar-empty" role="status"><Loader2 size={24} /><p>正在读取来源与摘要…</p></div> : null}
        {c.detailError ? <p className="error" role="alert">{c.detailError}</p> : null}
        {title ? <><div className="radar-reader-content"><div className="radar-story-meta">{topic?.monitorLabel || article?.sourceName} · {date(topic?.publishedAt || article?.publishedAt)}</div><h2>{title}</h2><p className="radar-reader-summary">{topic?.summary || article?.summary || "来源未提供摘要，请打开原文查看。"}</p>{topic ? <><section><h3>为什么值得关注</h3><p>{topic.whyNow}</p></section><section><h3>视频切入点</h3><p>{topic.entryPoint || topic.angles.join("；")}</p></section><section><h3>评论方向 <small>编辑预测</small></h3><p>{topic.commentDirection}</p></section></> : null}{topic?.risks.length ? <section><h3>待核实事项</h3><ul>{topic.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null}{topic?.evidence.length ? <details><summary>查看采集材料（未经独立核实）</summary>{topic.evidence.map((item, index) => <p key={index}>{item}</p>)}</details> : null}{topic?.timeline?.length ? <section><h3>事件来源与进展</h3>{topic.development ? <p>新进展判断：{topic.development}</p> : null}<ol>{topic.timeline.map(entry => <li key={entry.signalId}><a href={entry.url} target="_blank" rel="noreferrer">{entry.title}</a><p className="subtle">{entry.source} · {entry.publishedAt ? date(entry.publishedAt) : "发布时间待核实"}</p></li>)}</ol></section> : null}<section><h3>原始来源</h3>{c.detail?.signals.map(item => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="radar-evidence"><span>{item.sourceName}<strong>{item.title}</strong>{item.metrics ? <small>{item.metrics.rank ? `来源排名 ${item.metrics.rank} · ` : ""}{item.metrics.likes !== undefined ? `${item.metrics.likes} 赞 · ${item.metrics.comments || 0} 评论` : ""}（来源快照，非全网热度）</small> : null}</span><ExternalLink size={16} /></a>)}</section></div><footer className="radar-reader-actions">{topic ? <div className="radar-rating"><span>这个选题怎么样？</span>{(["吊爆了", "还行", "不行"] as const).map(rating => <button className="btn compact" disabled={c.saving} aria-pressed={topic.userRating === rating} key={rating} onClick={() => void c.rate(rating)}>{topic.userRating === rating ? <Check size={14} /> : null}{rating}</button>)}</div> : null}<p role="status">{c.notice}</p><button className="btn primary" onClick={c.write}>送入写作台<ArrowRight size={16} /></button></footer></> : null}
  </ModalBackdrop>;
}
