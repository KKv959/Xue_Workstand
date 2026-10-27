"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatDate } from "@/components/Formatters";
import type { EngagementRecord, EngagementRecordSummary } from "@/lib/types";
import { formatSourceType } from "./asset-view-utils";

type EngagementHistoryPaneProps = {
  loading: boolean;
  records: EngagementRecordSummary[];
  resultRecord: EngagementRecord | null;
  openingRecordId: string;
  onDeleteRecord: (record: EngagementRecordSummary) => Promise<void>;
  onExportRecord: (record: EngagementRecordSummary) => void;
  onSelectRecord: (record: EngagementRecordSummary) => Promise<void>;
};

type RecordContextMenu = {
  record: EngagementRecordSummary;
  x: number;
  y: number;
};

export function EngagementHistoryPane({
  loading,
  openingRecordId,
  records,
  resultRecord,
  onDeleteRecord,
  onExportRecord,
  onSelectRecord
}: EngagementHistoryPaneProps) {
  const [contextMenu, setContextMenu] = useState<RecordContextMenu | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EngagementRecordSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const selectedRecordRef = useRef<HTMLButtonElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!resultRecord?.id) return;
    selectedRecordRef.current?.scrollIntoView({ block: "nearest" });
  }, [records.length, resultRecord?.id]);

  useEffect(() => {
    if (!contextMenu) return;
    contextMenuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };

    const handleScroll = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
        contextTriggerRef.current?.focus();
      }
      if (!contextMenuRef.current) return;
      const items = [...contextMenuRef.current.querySelectorAll<HTMLElement>("[role=menuitem]")];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const contextMenuStyle = useMemo(() => {
    if (!contextMenu) return undefined;
    const menuWidth = 172;
    const menuHeight = 96;
    const zoom = typeof window === "undefined" ? 1 : Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const viewportWidth = typeof window === "undefined" ? contextMenu.x + menuWidth : window.innerWidth / zoom;
    const viewportHeight = typeof window === "undefined" ? contextMenu.y + menuHeight : window.innerHeight / zoom;
    return {
      left: Math.max(8, Math.min(contextMenu.x / zoom, viewportWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(contextMenu.y / zoom, viewportHeight - menuHeight - 8))
    };
  }, [contextMenu]);

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await onDeleteRecord(deleteTarget);
      setDeleteTarget(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <>
      <aside className="panel engagement-history-pane">
        <div className="pane-header">
          <div>
            <h2>历史记录</h2>
            <p className="pane-subtitle">链接和文案都会保存</p>
          </div>
        </div>
        <div className="pane-body">
          <div className="status-summary">
            <span>{loading ? "读取中" : `${records.length} 条记录`}</span>
            <span>{loading ? "历史记录" : "点击查看结果"}</span>
          </div>
          {loading ? (
            <HistoryLoadingRows />
          ) : records.length ? (
            records.map((record) => (
              <div className="engagement-history-row" key={record.id}>
                <button
                  aria-current={resultRecord?.id === record.id ? "true" : undefined}
                  className={`list-button ${resultRecord?.id === record.id ? "active" : ""}`}
                  disabled={Boolean(openingRecordId)}
                  onClick={() => void onSelectRecord(record)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    contextTriggerRef.current = event.currentTarget;
                    setContextMenu({ record, x: event.clientX, y: event.clientY });
                  }}
                  ref={resultRecord?.id === record.id ? selectedRecordRef : undefined}
                  type="button"
                >
                  <span>
                    <span className="list-title">{record.title}</span>
                    <span className="list-meta">{formatSourceType(record.sourceType)} · {formatDate(record.createdAt)}</span>
                  </span>
                  <span className="status-pill done">{openingRecordId === record.id ? "读取中" : `${record.commentCount}/${record.danmakuCount}`}</span>
                </button>
              </div>
            ))
          ) : (
            <p className="subtle">生成后会在这里保留记录。</p>
          )}
        </div>
      </aside>

      {contextMenu ? (
        <div
          className="history-context-menu"
          ref={contextMenuRef}
          role="menu"
          style={contextMenuStyle}
        >
          <button
            className="history-context-menu-item"
            role="menuitem"
            onClick={() => {
              onExportRecord(contextMenu.record);
              setContextMenu(null);
            }}
            type="button"
          >
            导出 Word
          </button>
          <button
            className="history-context-menu-item danger mobile-destructive-action"
            role="menuitem"
            onClick={() => {
              setDeleteTarget(contextMenu.record);
              setContextMenu(null);
            }}
            type="button"
          >
            删除记录
          </button>
        </div>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          body={`删除后这条评论历史会从本地移除，无法恢复。确认删除“${deleteTarget.title}”吗？`}
          busy={deleteBusy}
          confirmLabel="删除"
          title="删除历史记录"
          onCancel={() => {
            if (!deleteBusy) setDeleteTarget(null);
          }}
          onConfirm={() => void handleConfirmDelete()}
        />
      ) : null}
    </>
  );
}

function HistoryLoadingRows() {
  return (
    <div className="history-loading-list" aria-busy="true" aria-label="正在读取历史记录">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="history-placeholder-row" key={index}>
          <span className="history-placeholder-copy">
            <span />
            <small />
          </span>
          <em />
        </div>
      ))}
    </div>
  );
}
