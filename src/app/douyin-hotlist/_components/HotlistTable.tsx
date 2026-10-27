"use client";

import Image from "next/image";
import { Flame, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DouyinHotlistItem } from "@/lib/types";
import {
  formatAge,
  formatDate,
  formatNumber,
  getAvatarTone,
  getHeatStrength
} from "../_lib/douyin-hotlist-model";
import { AccountAvatarImage, PlatformLogoBadge } from "./HotlistIdentity";

const HOTLIST_INITIAL_RENDER_COUNT = 24;
const HOTLIST_RENDER_STEP = 24;
const FEATURED_COUNT = 3;
const scoreFormatter = new Intl.NumberFormat("zh-CN");

export type HotlistEntry = { item: DouyinHotlistItem; displayRank: number };

export function getHotlistItemKey(item: DouyinHotlistItem) {
  return `${item.account.id}:${item.video.id}`;
}

export function HotlistTable({
  items,
  showGlobalRank,
  selectedKey,
  onSelect
}: {
  items: HotlistEntry[];
  showGlobalRank: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);
  const [renderCount, setRenderCount] = useState(HOTLIST_INITIAL_RENDER_COUNT);
  const maxHeatScore = Math.max(...items.map(({ item }) => item.heatScore), 1);
  const featured = items.length > FEATURED_COUNT ? items.slice(0, FEATURED_COUNT) : [];
  const rows = items.slice(featured.length, renderCount);
  const renderedCount = featured.length + rows.length;
  const hasMore = renderedCount < items.length;
  const changedKeys = useChangedHeat(items);

  const loadMore = useCallback(() => {
    setRenderCount((current) => Math.min(current + HOTLIST_RENDER_STEP, items.length));
  }, [items.length]);

  useEffect(() => {
    setRenderCount(HOTLIST_INITIAL_RENDER_COUNT);
  }, [showGlobalRank]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "480px 0px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div className="hl-board">
      {featured.length ? (
        <div className="hl-featured ink-stagger">
          {featured.map(({ item, displayRank }, index) => {
            const key = getHotlistItemKey(item);
            return (
              <article
                key={key}
                className={`hl-feature ${key === selectedKey ? "selected" : ""} ${changedKeys.has(key) ? "ink-flash" : ""}`}
                style={{ "--i": index } as CSSProperties}
              >
                <button type="button" className="hl-hit" aria-label={`查看详情：${item.video.title}`} onClick={() => onSelect(key)} />
                <div className="hl-feature-cover">
                  <HotlistCover item={item} width={480} height={270} />
                  <span className="hl-feature-rank" aria-label={`第 ${displayRank} 名`}>{displayRank}</span>
                  {item.surge ? <SurgeBadge item={item} /> : null}
                </div>
                <div className="hl-feature-body">
                  <h3 title={item.video.title}>{item.video.title}</h3>
                  <div className="hl-feature-foot">
                    <AccountLine item={item} />
                    <strong className="hl-heat-number" title={`热度 ${scoreFormatter.format(item.heatScore)}`}>{formatNumber(item.heatScore)}</strong>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <div className="hl-list" role="list" aria-label="热榜">
        <div className="hl-list-head" aria-hidden="true">
          <span>#</span>
          <span />
          <span>视频</span>
          <span>点赞</span>
          <span>评论</span>
          <span>热度</span>
        </div>
        <div className="ink-stagger hl-list-rows">
          {rows.map(({ item, displayRank }, index) => {
            const key = getHotlistItemKey(item);
            return (
              <article
                key={key}
                role="listitem"
                className={`hl-row ${key === selectedKey ? "selected" : ""} ${item.surge ? "is-surging" : ""} ${changedKeys.has(key) ? "ink-flash" : ""}`}
                style={{ "--i": index } as CSSProperties}
              >
                <button type="button" className="hl-hit" aria-label={`查看详情：${item.video.title}`} onClick={() => onSelect(key)} />
                <span className="hl-row-rank" aria-label={`第 ${displayRank} 名`}>
                  {displayRank}
                  {showGlobalRank ? <small>总 {item.rank}</small> : null}
                </span>
                <span className="hl-row-cover"><HotlistCover item={item} width={96} height={54} /></span>
                <span className="hl-row-main">
                  <span className="hl-row-title" title={item.video.title}>{item.video.title}</span>
                  <span className="hl-row-meta">
                    <AccountLine item={item} compact />
                    {item.surge ? <SurgeBadge item={item} /> : <span className="hl-row-signal">{item.signal}</span>}
                  </span>
                </span>
                <span className="hl-row-num">{formatNumber(item.video.stats.likes)}</span>
                <span className="hl-row-num">{formatNumber(item.video.stats.comments)}</span>
                <span className="hl-row-heat">
                  <strong className="hl-heat-number" style={{ "--heat-strength": `${getHeatStrength(item.heatScore, maxHeatScore)}%` } as CSSProperties}>{formatNumber(item.heatScore)}</strong>
                </span>
              </article>
            );
          })}
        </div>
        {hasMore ? (
          <div className="hl-load-more">
            <button className="btn compact" onClick={loadMore} ref={loadMoreRef} type="button">
              继续显示 · {renderedCount}/{items.length}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 对比上一份数据，只标出热度变化的条目，用于原地闪烁。 */
function useChangedHeat(items: HotlistEntry[]) {
  const previousRef = useRef<Map<string, number> | null>(null);
  const changed = useMemo(() => {
    const previous = previousRef.current;
    const keys = new Set<string>();
    if (!previous) return keys;
    for (const { item } of items) {
      const before = previous.get(getHotlistItemKey(item));
      if (before !== undefined && before !== item.heatScore) keys.add(getHotlistItemKey(item));
    }
    return keys;
  }, [items]);
  useEffect(() => {
    previousRef.current = new Map(items.map(({ item }) => [getHotlistItemKey(item), item.heatScore]));
  }, [items]);
  return changed;
}

function AccountLine({ item, compact = false }: { item: DouyinHotlistItem; compact?: boolean }) {
  return (
    <span className="hl-account">
      <span className={`hl-avatar tone-${getAvatarTone(item.account.id)} ${item.account.avatarUrl ? "has-image" : ""}`} aria-hidden="true">
        <AccountAvatarImage account={item.account} size={compact ? 18 : 22} />
      </span>
      <span className="hl-account-name">{item.account.name}</span>
      <span className="hl-account-age">{item.ageHours !== undefined ? formatAge(item.ageHours) : formatDate(item.video.publishedAt)}</span>
    </span>
  );
}

export function SurgeBadge({ item }: { item: DouyinHotlistItem }) {
  if (!item.surge) return null;
  return (
    <span className="hl-surge" title={item.surge.reason}>
      <Zap aria-hidden="true" size={11} strokeWidth={2.4} />
      {item.surge.label}
    </span>
  );
}

export function HotlistLoadingRows() {
  return (
    <div className="hl-board" aria-label="正在读取热榜" aria-busy="true">
      <div className="hl-featured">
        {Array.from({ length: 3 }).map((_, index) => (
          <div className="hl-feature hl-skeleton" key={index}>
            <span className="hl-feature-cover" />
            <span className="hl-skeleton-line" />
            <span className="hl-skeleton-line short" />
          </div>
        ))}
      </div>
      <div className="hl-list">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="hl-row hl-skeleton" key={index}>
            <span className="hl-row-rank" />
            <span className="hl-row-cover" />
            <span className="hl-row-main"><span className="hl-skeleton-line" /><span className="hl-skeleton-line short" /></span>
          </div>
        ))}
      </div>
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
    <div className="hl-empty">
      <span className="hl-empty-mark" aria-hidden="true"><Flame size={22} /></span>
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

export function HotlistCover({ item, width, height }: { item: DouyinHotlistItem; width: number; height: number }) {
  const [coverFailed, setCoverFailed] = useState(false);

  useEffect(() => {
    setCoverFailed(false);
  }, [item.account.avatarUrl, item.video.coverUrl]);

  if (item.video.coverUrl && !coverFailed) {
    return (
      <Image
        alt=""
        className="hl-cover-image"
        height={height}
        onError={() => setCoverFailed(true)}
        referrerPolicy="no-referrer"
        src={item.video.coverUrl}
        unoptimized
        width={width}
      />
    );
  }

  return (
    <span className={`hl-cover-placeholder tone-${getAvatarTone(item.account.id)}`} aria-hidden="true">
      <AccountAvatarImage account={item.account} size={28} />
    </span>
  );
}

export { PlatformLogoBadge };
