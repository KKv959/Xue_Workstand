"use client";

import { memo, type ReactNode } from "react";
import { Button, Menu, MenuItem, MenuTrigger } from "react-aria-components";
import { WorkbenchSelectPopover } from "@/components/WorkbenchSelect";
import { ArrowUpRight, Download, ExternalLink, MoreHorizontal, RefreshCw, Sparkles, WandSparkles } from "lucide-react";
import { formatDate } from "@/components/Formatters";
import type { AccountDetail, VideoListItem } from "@/lib/types";

type LibraryDetailPaneProps = {
  busy: string;
  loading: boolean;
  selectedAccount: AccountDetail | null;
  selectedVideo: VideoListItem | null;
  selectedVideoHasTranscript: boolean;
  selectedVideoOpenUrl: string;
  styleLoaded: boolean;
  styleLoading: boolean;
  styleProgress: number;
  stylePreview: string;
  transcriptLoading: boolean;
  transcriptError: string;
  transcriptPreview: string;
  transcribeProgress: number;
  transcribeStage: string;
  onBatchTranscribe: () => void;
  onExportTranscripts: () => void;
  onGenerateBatchStyle: () => void;
  onGenerateStyle: () => void;
  onOpenStyleModal: () => void;
  onOpenTranscriptModal: () => void;
  onTranscribe: () => void;
};

export const LibraryDetailPane = memo(function LibraryDetailPane({
  busy,
  loading,
  selectedAccount,
  selectedVideo,
  selectedVideoHasTranscript,
  selectedVideoOpenUrl,
  styleLoaded,
  styleLoading,
  styleProgress,
  stylePreview,
  transcriptLoading,
  transcriptError,
  transcriptPreview,
  transcribeProgress,
  transcribeStage,
  onBatchTranscribe,
  onExportTranscripts,
  onGenerateBatchStyle,
  onGenerateStyle,
  onOpenStyleModal,
  onOpenTranscriptModal,
  onTranscribe
}: LibraryDetailPaneProps) {
  const missingTranscriptCount = selectedAccount ? Math.max(0, selectedAccount.videoCount - selectedAccount.transcriptCount) : 0;
  const transcriptPreviewText = transcriptPreview || (transcriptLoading || loading
    ? "正在读取原稿…"
    : selectedVideoHasTranscript ? "原稿暂无正文。"
    : selectedVideo ? "转写后，这里会直接展示原稿内容。" : "选择一个视频，查看原稿内容。");
  const stylePreviewText = stylePreview || (loading || styleLoading
    ? "正在读取风格卡…" : "根据已转写的原稿总结账号风格，生成后可在这里直接预览。");
  const styleBusy = busy === "style" || busy === "batch-style";

  return (
    <aside className="pane library-detail-pane">
      <div className="pane-header library-detail-header">
        <div>
          <h2>详情</h2>
          <p className="pane-subtitle">{loading ? "正在读取" : selectedAccount?.name || "未选择账号"}</p>
          {selectedAccount?.lastCollectedAt ? <span className="detail-freshness">最近采集 {formatDate(selectedAccount.lastCollectedAt)}</span> : null}
        </div>
      </div>
      <div className="pane-body detail-stack">
        <section className="detail-section selected-video-section" aria-label="转写稿">
          <div className="detail-heading-row">
            <h3>转写稿</h3>
            <DetailMenu key={selectedVideo?.id} label="转写稿更多操作" disabled={!selectedVideo}>
              {selectedVideoOpenUrl ? (
                <MenuItem className="workbench-select-option" textValue="查看原视频" href={selectedVideoOpenUrl} target="_blank" rel="noreferrer">
                  <span>查看原视频</span><ExternalLink aria-hidden="true" size={16} />
                </MenuItem>
              ) : null}
              {selectedVideoHasTranscript ? (
                <MenuItem className="workbench-select-option" textValue="重新转写" isDisabled={busy === "transcribe"} onAction={onTranscribe}>
                  <span>重新转写</span><RefreshCw aria-hidden="true" size={16} />
                </MenuItem>
              ) : null}
            </DetailMenu>
          </div>
          <p className="detail-excerpt-title">{selectedVideo?.title || "未选择视频"}</p>
          {selectedVideoHasTranscript ? (
            <button className="detail-excerpt" aria-label={transcriptError ? "重试读取原稿" : "查看 / 编辑原稿"} aria-busy={transcriptLoading} disabled={transcriptLoading || busy === "transcribe"} onClick={onOpenTranscriptModal} type="button">
              <span className={`detail-excerpt-body${transcriptError ? " detail-excerpt-error" : ""}`}>{transcriptError || transcriptPreviewText}</span>
              <span className="detail-excerpt-footer">{transcriptLoading ? "读取中…" : transcriptError ? "重试读取" : "查看 / 编辑原稿"}<ArrowUpRight aria-hidden="true" size={16} /></span>
            </button>
          ) : (
            <>
              <p className="detail-empty-preview">{transcriptPreviewText}</p>
              {selectedVideo ? <button className="btn primary" disabled={busy === "transcribe"} onClick={onTranscribe} type="button"><WandSparkles aria-hidden="true" size={16} />{busy === "transcribe" ? "转写中…" : "开始转写"}</button> : null}
            </>
          )}
          {busy === "transcribe" ? <p className="detail-task-status" role="status">{transcribeStage || "正在转写视频"} · {transcribeProgress}%</p> : null}
        </section>

        <section className="detail-section automation-section" aria-label="账号风格">
          <div className="detail-heading-row">
            <h3>账号风格</h3>
            <DetailMenu key={selectedAccount?.id} label="账号风格更多操作" disabled={!selectedAccount}>
              <MenuItem className="workbench-select-option" textValue={styleLoaded ? "重新总结" : "按现有稿总结"} isDisabled={styleLoading || styleBusy || !selectedAccount?.transcriptCount} onAction={onGenerateStyle}>
                <span>{styleLoaded ? "重新总结" : "按现有稿总结"}</span><Sparkles aria-hidden="true" size={16} />
              </MenuItem>
              <MenuItem className="workbench-select-option" textValue="导出全部转写" isDisabled={!selectedAccount?.transcriptCount || busy === "export-transcripts"} onAction={onExportTranscripts}>
                <span>{busy === "export-transcripts" ? "导出中…" : "导出全部转写"}</span><Download aria-hidden="true" size={16} />
              </MenuItem>
              {missingTranscriptCount ? (
                <MenuItem className="workbench-select-option" textValue={`补齐 ${missingTranscriptCount} 条转写`} isDisabled={busy === "batch" || busy === "batch-style"} onAction={onBatchTranscribe}>
                  <span>补齐 {missingTranscriptCount} 条转写</span><WandSparkles aria-hidden="true" size={16} />
                </MenuItem>
              ) : null}
              {missingTranscriptCount ? (
                <MenuItem className="workbench-select-option" textValue="补齐并总结" isDisabled={styleBusy || busy === "batch"} onAction={onGenerateBatchStyle}>
                  <span>补齐并总结</span><Sparkles aria-hidden="true" size={16} />
                </MenuItem>
              ) : null}
            </DetailMenu>
          </div>
          <button className="detail-excerpt detail-style-excerpt" aria-label="查看 / 编辑风格卡" aria-busy={styleLoading} disabled={!selectedAccount || styleLoading || styleBusy} onClick={onOpenStyleModal} type="button">
            <span className="detail-excerpt-body">{stylePreviewText}</span>
            <span className="detail-excerpt-footer">{styleLoading ? "读取中…" : "查看 / 编辑风格卡"}<ArrowUpRight aria-hidden="true" size={16} /></span>
          </button>
          {!styleLoaded && selectedAccount && !styleBusy ? (
            <button className="btn" disabled={styleLoading || !selectedAccount.transcriptCount} onClick={onGenerateStyle} type="button"><Sparkles aria-hidden="true" size={16} />按现有稿总结</button>
          ) : null}
          {styleBusy || busy === "batch" || busy === "export-transcripts" ? (
            <p className="detail-task-status" role="status">{busy === "style" ? `正在总结风格 · ${styleProgress}%` : busy === "export-transcripts" ? "正在导出全部转写…" : `${transcribeStage || "正在补齐转写"} · ${transcribeProgress}%`}</p>
          ) : null}
        </section>
      </div>
    </aside>
  );
});

function DetailMenu({ label, disabled, children }: { label: string; disabled: boolean; children: ReactNode }) {
  return (
    <MenuTrigger>
      <Button className="btn compact detail-more-trigger" aria-label={label} isDisabled={disabled}><MoreHorizontal aria-hidden="true" size={16} /><span>更多</span></Button>
      <WorkbenchSelectPopover placement="bottom end" offset={6}>
        <Menu className="workbench-select-options library-detail-menu" aria-label={label}>{children}</Menu>
      </WorkbenchSelectPopover>
    </MenuTrigger>
  );
}
