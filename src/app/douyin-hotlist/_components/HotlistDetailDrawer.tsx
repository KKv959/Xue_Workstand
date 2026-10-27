"use client";

import Link from "next/link";
import { ChevronDown, ChevronUp, MessageSquarePlus, PenLine, Play, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { formatAge, formatDate, formatNumber, getMetricItems, getPlatformLabel, getVideoExternalUrl } from "../_lib/douyin-hotlist-model";
import { AccountAvatarImage, PlatformLogoBadge } from "./HotlistIdentity";
import { HotlistCover, SurgeBadge, type HotlistEntry } from "./HotlistTable";

const scoreFormatter = new Intl.NumberFormat("zh-CN");

/**
 * 视频详情抽屉：从右侧推入，列表保持原位可继续操作。
 * Esc 关闭，↑/↓ 或 K/J 切换上一条、下一条。
 */
export function HotlistDetailDrawer({ entry, position, total, onClose, onStep }: {
  entry: HotlistEntry;
  position: number;
  total: number;
  onClose: () => void;
  onStep: (delta: number) => void;
}) {
  const { item, displayRank } = entry;
  const panelRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const sourceUrl = getVideoExternalUrl(item.video);
  const writeHref = `/writer?${new URLSearchParams({ sourceText: sourceUrl })}`;
  const commentHref = `/assets?${new URLSearchParams({ source: sourceUrl })}`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (event.key === "Escape") onClose();
      else if (event.key === "w") { event.preventDefault(); router.push(writeHref); }
      else if (event.key === "ArrowDown" || event.key === "j") { event.preventDefault(); onStep(1); }
      else if (event.key === "ArrowUp" || event.key === "k") { event.preventDefault(); onStep(-1); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onStep, router, writeHref]);

  // 切换条目时滚回顶部，并把列表中对应行滚进视野。
  useEffect(() => {
    panelRef.current?.querySelector(".hl-detail-scroll")?.scrollTo({ top: 0 });
    document.querySelector(".hl-row.selected, .hl-feature.selected")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [item.video.id]);

  return (
    <aside className="hl-detail" ref={panelRef} aria-label="视频详情">
      <header className="hl-detail-head">
        <span className="hl-detail-position">#{displayRank} · 详情 <small>{position + 1}/{total}</small></span>
        <div className="hl-detail-nav">
          <button type="button" className="hl-detail-nav-btn" aria-label="上一条（↑）" disabled={position <= 0} onClick={() => onStep(-1)}>
            <ChevronUp size={16} aria-hidden="true" />
          </button>
          <button type="button" className="hl-detail-nav-btn" aria-label="下一条（↓）" disabled={position >= total - 1} onClick={() => onStep(1)}>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <button type="button" className="hl-detail-nav-btn is-close" aria-label="关闭详情（Esc）" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="hl-detail-scroll" key={item.video.id}>
        <a className="hl-detail-cover" href={sourceUrl} target="_blank" rel="noreferrer" aria-label="在新标签打开原视频">
          <HotlistCover item={item} width={720} height={405} />
          <span className="hl-detail-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
          {item.surge ? <span className="hl-detail-cover-badge"><SurgeBadge item={item} /></span> : null}
        </a>
        <h2 className="hl-detail-title">{item.video.title}</h2>
        <div className="hl-detail-account">
          <span className="hl-avatar has-image" aria-hidden="true"><AccountAvatarImage account={item.account} size={28} /></span>
          <span>
            <strong>{item.account.name}</strong>
            <small>{getPlatformLabel(item.account.platform)} · {item.ageHours !== undefined ? formatAge(item.ageHours) : formatDate(item.video.publishedAt)}</small>
          </span>
          <PlatformLogoBadge platform={item.account.platform} />
        </div>
        <dl className="hl-detail-metrics">
          <div>
            <dt>热度</dt>
            <dd title={scoreFormatter.format(item.heatScore)}>{formatNumber(item.heatScore)}</dd>
          </div>
          <div>
            <dt>点赞</dt>
            <dd>{formatNumber(item.video.stats.likes)}</dd>
          </div>
          <div>
            <dt>评论</dt>
            <dd>{formatNumber(item.video.stats.comments)}</dd>
          </div>
        </dl>
        <section className="hl-detail-why">
          <h3>为什么上榜</h3>
          <p>{item.surge ? item.surge.reason : item.signal}</p>
          {item.tags.length ? <div className="hl-detail-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
        </section>
        <dl className="hl-detail-more">
          {getMetricItems(item.video).filter((metric) => metric.label !== "点赞" && metric.label !== "评论").map((metric) => (
            <div key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>{formatNumber(metric.value)}</dd>
            </div>
          ))}
          <div>
            <dt>发布</dt>
            <dd>{formatDate(item.video.publishedAt)}</dd>
          </div>
        </dl>
      </div>
      <footer className="hl-detail-actions">
        <Link className="btn primary" href={writeHref}>
          <PenLine size={16} aria-hidden="true" />
          用它写
          <kbd>W</kbd>
        </Link>
        <Link className="btn" href={commentHref}>
          <MessageSquarePlus size={16} aria-hidden="true" />
          评论生成
        </Link>
      </footer>
    </aside>
  );
}
