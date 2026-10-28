"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Copy, FileUp } from "lucide-react";

type AssetTextListProps = {
  title: string;
  items: string[];
  itemOrigins?: Array<"ai_generated" | "reused_hot_comment" | undefined>;
  empty: string;
  onCopy: () => void;
  leadingActions?: ReactNode;
  onPublish?: () => void;
  publishDisabled?: boolean;
  publishing?: boolean;
};

export function AssetTextList({
  title,
  items,
  itemOrigins,
  empty,
  onCopy,
  leadingActions,
  onPublish,
  publishDisabled,
  publishing
}: AssetTextListProps) {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();

  return (
    <div className="asset-list-block">
      <div className="section-title-row">
        <h3>{title}</h3>
        <div className="button-row">
          <button
            aria-controls={contentId}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "展开" : "收起"}${title}`}
            className="btn compact"
            disabled={!items.length}
            onClick={() => setCollapsed((current) => !current)}
            type="button"
          >
            {collapsed ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronUp aria-hidden="true" size={16} />}
            {collapsed ? "展开" : "收起"}
          </button>
          {leadingActions}
          <button
            aria-label={`复制${title}`}
            className="btn compact icon-only"
            disabled={!items.length}
            onClick={onCopy}
            title={`复制${title}`}
            type="button"
          >
            <Copy aria-hidden="true" size={16} />
          </button>
          {onPublish ? (
            <button
              aria-busy={publishing}
              aria-label={publishing ? `正在导出${title}到飞书` : `导出${title}到飞书`}
              className="btn compact icon-only"
              disabled={!items.length || publishDisabled}
              onClick={onPublish}
              title={publishing ? "正在导出到飞书" : "导出到飞书"}
              type="button"
            >
              <FileUp aria-hidden="true" size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div className={`asset-text-list ${items.length ? "" : "empty"}`} hidden={collapsed} id={contentId}>
        {!collapsed && (items.length ? items.map((item, index) => {
          const origin = itemOrigins?.[index];
          const originLabel = origin === "reused_hot_comment"
            ? "相关原评"
            : origin === "ai_generated"
              ? "AI 生成"
              : "";
          return (
            <p className={origin ? `origin-${origin}` : undefined} key={`${index}-${item}`}>
              {item}
              {originLabel ? <span className={`asset-item-origin origin-${origin}`}>{originLabel}</span> : null}
            </p>
          );
        }) : empty)}
      </div>
    </div>
  );
}
