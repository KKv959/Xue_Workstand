"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import { useState } from "react";
import type { EngagementRecord } from "@/lib/types";

type Research = NonNullable<NonNullable<NonNullable<EngagementRecord["comments"]>["diagnostics"]>["relatedResearch"]>;

export function EngagementResearchDetails({ research }: { research: Research }) {
  const [limit, setLimit] = useState(20);
  const [filter, setFilter] = useState("all");
  const review = research.review;
  const rows = (review?.decisions || []).filter((row) => filter === "all" || row.keep === (filter === "kept"));
  return (
    <details className="engagement-research-details">
      <summary>{review ? `查看历史原评审核 · 已审 ${review.reviewedCount}/${review.candidateCount}` : "查看采集与表达参考"}</summary>
      <p>{research.voiceReferences ? `本次使用 ${research.voiceReferences.length} 条自然表达学习语气；语境不匹配的样本只参考说话方式，来源人物与事实不进入新评论。` : "原生评论用于学习平台语气与讨论方式，新生成的评论围绕当前文案创作。"}</p>
      {typeof research.capturedCommentCount === "number" ? <p>去重采集 {research.capturedCommentCount} 条，整组隔离 {research.quarantinedCommentCount || 0} 条。</p> : null}
      {review ? <p role="status">语境筛选{review.status === "completed" ? "全部完成" : "部分完成"}：保留 {review.reviewedCount - review.rejectedCount}，拒绝 {review.rejectedCount}，未审 {review.unreviewedCount}。未审评论不进入参考。</p> : null}
      {!review && research.voiceReferences ? <p>原评按来源、长短和点赞轮转选择，参考 JSON 最多 12,000 字符，不限制 80 条或每视频 20 条。只学习表达；新生成评论直接保存，不再执行 AI 审核或本地内容筛选。</p> : null}
      {research.summaryError ? <p className="notice">{research.summaryError}</p> : null}
      <ul>
        {(research.searchPlan || []).map((source) => <li key={source.query}><strong>{source.query}</strong> · {source.videoType}<br />{source.discussion}</li>)}
      </ul>
      {review ? (
        <>
          <label>筛选明细 <WorkbenchSelect aria-label="筛选明细" value={filter} onValueChange={(value) => { setFilter(value); setLimit(20); }}>
            <option value="all">全部</option><option value="kept">保留</option><option value="rejected">拒绝</option>
          </WorkbenchSelect></label>
          <ol>
            {rows.slice(0, limit).map((row, index) => (
              <li key={`${row.platform}:${row.videoId}:${index}`}>
                <strong>{row.keep ? "语境保留" : research.voiceReferences?.includes(row.text) ? "语境拒绝 · 仅参考语气" : "拒绝"} · {row.text}</strong>
                <p>{row.reason}</p>
                {row.articleEvidence ? <p>正文依据：{row.articleEvidence}</p> : null}
                <p>来源：<a href={row.platform === "douyin" ? `https://www.douyin.com/video/${encodeURIComponent(row.videoId)}` : `https://www.bilibili.com/video/${encodeURIComponent(row.videoId)}`} target="_blank" rel="noreferrer">{row.videoTitle || row.videoId}</a> · 搜索词：{row.query}</p>
              </li>
            ))}
          </ol>
          {rows.length > limit ? <button className="btn compact" type="button" onClick={() => setLimit((value) => value + 20)}>再显示 20 条（共 {rows.length} 条）</button> : null}
        </>
      ) : research.voiceReferences ? (
        <>
          <ol>{research.voiceReferences.slice(0, limit).map((text, index) => <li key={`${index}:${text}`}>{text}</li>)}</ol>
          {research.voiceReferences.length > limit ? <button className="btn compact" type="button" onClick={() => setLimit((value) => value + 20)}>再显示 20 条（共 {research.voiceReferences.length} 条）</button> : null}
        </>
      ) : null}
    </details>
  );
}
