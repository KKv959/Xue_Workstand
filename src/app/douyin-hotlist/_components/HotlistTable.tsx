"use client";

import Image from "next/image";
import { Clock3, ExternalLink, Flame, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { DouyinHotlistItem } from "@/lib/types";
import {
  formatAge,
  formatDate,
  formatNumber,
  getAvatarTone,
  getHeatStrength,
  getMetricItems,
  getRankClass,
  getSurgeClass,
  getVideoExternalUrl,
  type MetricTone
} from "../_lib/douyin-hotlist-model";
import { AccountAvatarImage, PlatformLogoBadge } from "./HotlistIdentity";

const HOTLIST_INITIAL_RENDER_COUNT = 24;
const HOTLIST_RENDER_STEP = 24;
const scoreFormatter = new Intl.NumberFormat("zh-CN");

export function HotlistTable({
  items,
  showGlobalRank
}: {
  items: { item: DouyinHotlistItem; displayRank: number }[];
  showGlobalRank: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);
  const [renderCount, setRenderCount] = useState(HOTLIST_INITIAL_RENDER_COUNT);
  const maxHeatScore = Math.max(...items.map(({ item }) => item.heatScore), 1);
  const renderedItems = items.slice(0, renderCount);
  const hasMore = renderedItems.length < items.length;
  const remainingCount = Math.max(items.length - renderedItems.length, 0);

  const loadMore = useCallback(() => {
    setRenderCount((current) => Math.min(current + HOTLIST_RENDER_STEP, items.length));
  }, [items.length]);

  useEffect(() => {
    setRenderCount(HOTLIST_INITIAL_RENDER_COUNT);
    listRef.current?.scrollTo({ left: 0, top: 0 });
  }, [items, showGlobalRank]);

  useEffect(() => {
    const root = listRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || !hasMore || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: "320px 0px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div className="douyin-hotlist-list" ref={listRef}>
      {renderedItems.map(({ item, displayRank }) => {
        const surgeClass = getSurgeClass(item.surge);

        return (
          <article
            className={`douyin-hotlist-item has-cover ${getRankClass(displayRank)} ${surgeClass}`}
            key={`${item.account.id}:${item.video.id}`}
          >
            <div className="douyin-hotlist-rank" aria-label={`第 ${displayRank} 名`}>
              <strong>{displayRank}</strong>
              <span>{showGlobalRank ? `总榜 ${item.rank}` : "热榜"}</span>
            </div>
            <div className="douyin-hotlist-item-content">
              <div className="douyin-hotlist-item-head">
                <HotlistCover item={item} />
                <div className="douyin-hotlist-item-main">
                  <h3 title={item.video.title}>{item.video.title}</h3>
                  <div className="douyin-hotlist-item-meta">
                    <span className="douyin-hotlist-account-meta">
                      <span
                        className={`douyin-hotlist-source-avatar tone-${getAvatarTone(item.account.id)} ${item.account.avatarUrl ? "has-image" : ""}`}
                        aria-hidden="true"
                      >
                        <AccountAvatarImage account={item.account} size={22} />
                      </span>
                      <PlatformLogoBadge platform={item.account.platform} />
                      {item.account.name}
                    </span>
                    <span>
                      <Clock3 aria-hidden="true" size={12} />
                      {formatDate(item.video.publishedAt)}
                      {item.ageHours !== undefined ? ` · ${formatAge(item.ageHours)}` : ""}
                    </span>
                  </div>
                  <div className="douyin-hotlist-signal-row">
                    <span className="douyin-hotlist-signal">{item.signal}</span>
                    {item.surge ? (
                      <span className={`douyin-hotlist-surge-badge ${surgeClass}`} title={item.surge.reason} aria-label={item.surge.reason}>
                        <Zap aria-hidden="true" size={12} />
                        {item.surge.label}
                      </span>
                    ) : null}
                  </div>
                  {item.tags.length ? (
                    <div className="douyin-hotlist-tags">
                      {item.tags.map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                  ) : null}
                </div>
                <a className="btn icon-only compact" href={getVideoExternalUrl(item.video)} target="_blank" rel="noreferrer" aria-label={`打开 ${item.video.title}`}>
                  <ExternalLink aria-hidden="true" size={15} />
                </a>
              </div>

              <div className="douyin-hotlist-item-data">
                <div className="douyin-hotlist-metrics" aria-label="互动数据">
                  {getMetricItems(item.video).map((metric) => (
                    <Metric key={metric.label} label={metric.label} tone={metric.tone} value={metric.value} />
                  ))}
                </div>
                <div className="douyin-hotlist-heat">
                  <div className="douyin-hotlist-score">
                    <span>热度</span>
                    <strong>{scoreFormatter.format(item.heatScore)}</strong>
                  </div>
                  <div className="douyin-hotlist-heat-track" aria-hidden="true">
                    <span style={{ "--heat-strength": `${getHeatStrength(item.heatScore, maxHeatScore)}%` } as CSSProperties} />
                  </div>
                  <small>互动与发布时间综合</small>
                </div>
              </div>
            </div>
          </article>
        );
      })}
      {hasMore ? (
        <div className="douyin-hotlist-load-more">
          <button className="btn compact" onClick={loadMore} ref={loadMoreRef} type="button">
            继续显示 · 已载入 {renderedItems.length}/{items.length}
          </button>
          <span>向下滚动会自动载入剩余 {remainingCount} 条</span>
        </div>
      ) : null}
    </div>
  );
}

export function HotlistLoadingRows() {
  return (
    <div className="douyin-hotlist-list douyin-hotlist-skeleton-list" aria-label="正在读取热榜">
      {Array.from({ length: 6 }).map((_, index) => (
        <article className="douyin-hotlist-item douyin-hotlist-item-skeleton" key={index}>
          <span className="douyin-hotlist-rank-skeleton" />
          <div className="douyin-hotlist-item-skeleton-content">
            <span />
            <span />
            <span />
          </div>
        </article>
      ))}
    </div>
  );
}

export function EmptyHotlist({
  hasAccounts,
  selectedAccount,
  windowLabel
}: {
  hasAccounts: boolean;
  selectedAccount?: string;
  windowLabel: string;
}) {
  return (
    <div className="empty-state-panel douyin-hotlist-empty-rank">
      <Flame aria-hidden="true" size={18} />
      <h2>暂无{windowLabel}内容</h2>
      <p className="subtle">
        {selectedAccount
          ? `${selectedAccount} ${windowLabel}还没有可排序内容，可切换时间范围或重新抓取。`
          : hasAccounts
            ? `${windowLabel}暂时没有可排序内容，可切换时间范围或重新抓取。`
            : "添加账号后抓取，榜单会按跨账号热度排序。"}
      </p>
    </div>
  );
}

function HotlistCover({ item }: { item: DouyinHotlistItem }) {
  const [coverFailed, setCoverFailed] = useState(false);

  useEffect(() => {
    setCoverFailed(false);
  }, [item.account.avatarUrl, item.video.coverUrl]);

  if (item.video.coverUrl && !coverFailed) {
    return (
      <Image
        alt=""
        className="douyin-hotlist-cover"
        height={76}
        onError={() => setCoverFailed(true)}
        referrerPolicy="no-referrer"
        src={item.video.coverUrl}
        unoptimized
        width={56}
      />
    );
  }

  return (
    <span className={`douyin-hotlist-cover douyin-hotlist-cover-placeholder tone-${getAvatarTone(item.account.id)}`} aria-hidden="true">
      <AccountAvatarImage account={item.account} size={32} />
    </span>
  );
}

function Metric({
  label,
  tone,
  value
}: {
  label: string;
  tone: MetricTone;
  value: number;
}) {
  return (
    <span className={`douyin-hotlist-metric tone-${tone}`}>
      <small>{label}</small>
      <strong>{formatNumber(value)}</strong>
    </span>
  );
}
