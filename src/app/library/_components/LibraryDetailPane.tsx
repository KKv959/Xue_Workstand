"use client";

import { memo } from "react";
import { ArrowUpRight, Download, ExternalLink, FileText, RefreshCw, Sparkles, WandSparkles } from "lucide-react";
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
  const transcriptPreviewText = transcriptPreview || (transcriptLoading || loading
    ? "正在读取原稿…"
    : selectedVideoHasTranscript ? "原稿暂无正文。"
    : selectedVideo ? "转写后，这里会直接展示原稿内容。" : "选择一个视频，查看原稿内容。");
  const stylePreviewText = stylePreview || (loading || styleLoading
    ? "正在读取风格卡…" : "根据已转写的原稿总结账号风格，生成后可在这里直接预览。");
  const missingTranscriptCount = selectedAccount ? Math.max(0, selectedAccount.videoCount - selectedAccount.transcriptCount) : 0;

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
            {selectedVideoHasTranscript ? (
              <button className="btn compact detail-inline-action" disabled={busy === "transcribe"} onClick={onTranscribe} type="button">
                <RefreshCw aria-hidden="true" size={14} />{busy === "transcribe" ? "转写中…" : "重新转写"}
              </button>
            ) : null}
          </div>
          <p className="detail-excerpt-title">
            {selectedVideoOpenUrl ? (
              <a className="detail-video-source" href={selectedVideoOpenUrl} target="_blank" rel="noreferrer" aria-label={`查看原视频：${selectedVideo?.title}`}>
                {selectedVideo?.title}<ExternalLink aria-hidden="true" size={14} />
              </a>
            ) : selectedVideo?.title || "未选择视频"}
          </p>
          {selectedVideoHasTranscript ? (
            <button className="detail-excerpt" aria-label={transcriptError ? "重试读取原稿" : "查看 / 编辑原稿"} aria-busy={transcriptLoading} disabled={transcriptLoading || busy === "transcribe"} onClick={onOpenTranscriptModal} type="button">
              <span className={`detail-excerpt-body${transcriptError ? " detail-excerpt-error" : ""}`}>{transcriptError || transcriptPreviewText}</span>
              <span className="detail-excerpt-footer">{transcriptLoading ? "读取中…" : transcriptError ? "重试读取" : "阅读全文"}<ArrowUpRight aria-hidden="true" size={16} /></span>
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
          <div className="detail-module-heading">
            <h3>账号风格</h3>
            <p className="pane-subtitle">{styleLoaded ? "风格卡已生成" : missingTranscriptCount ? `${missingTranscriptCount} 条待转写` : "可根据现有稿总结"}</p>
          </div>
          <p className="detail-preview-text detail-style-preview">{stylePreviewText}</p>
          <div className="detail-action-grid account-style-actions">
            <button
              className="btn detail-action-primary"
              disabled={!selectedAccount || styleLoading || busy === "style"}
              onClick={onOpenStyleModal}
              type="button"
            >
              <FileText aria-hidden="true" size={16} />
              {styleLoading ? "读取中…" : "查看 / 编辑风格卡"}
            </button>
            <button
              aria-busy={busy === "style"}
              className="btn detail-action-secondary progress-button"
              disabled={!selectedAccount || styleLoading || busy === "style"}
              onClick={onGenerateStyle}
              type="button"
            >
              <span className="progress-button-fill" style={{ transform: `scaleX(${busy === "style" ? styleProgress / 100 : 0})` }} />
              <span className="progress-button-content">
                <Sparkles aria-hidden="true" size={16} />
                {busy === "style" ? "总结中…" : styleLoaded ? "重新总结" : "按现有稿总结"}
              </span>
            </button>
            <button
              aria-busy={busy === "export-transcripts"}
              className="btn detail-action-secondary"
              disabled={!selectedAccount || !selectedAccount.transcriptCount || busy === "export-transcripts"}
              onClick={() => onExportTranscripts()}
              type="button"
            >
              <Download aria-hidden="true" size={16} />{busy === "export-transcripts" ? "导出中…" : "导出全部转写"}
            </button>
            {missingTranscriptCount ? (
              <>
                <button className="btn detail-action-secondary" disabled={!selectedAccount || busy === "batch"} onClick={onBatchTranscribe} type="button">
                  <WandSparkles aria-hidden="true" size={16} />
                  {busy === "batch" ? `转写中 ${transcribeProgress}%` : `补齐 ${missingTranscriptCount} 条`}
                </button>
                <button
                  aria-busy={busy === "batch-style"}
                  className="btn detail-action-secondary progress-button"
                  disabled={!selectedAccount || busy === "batch-style"}
                  onClick={onGenerateBatchStyle}
                  type="button"
                >
                  <span className="progress-button-fill" style={{ transform: `scaleX(${busy === "batch-style" ? transcribeProgress / 100 : 0})` }} />
                  <span className="progress-button-content"><Sparkles aria-hidden="true" size={16} />{busy === "batch-style" ? `补齐并总结 ${transcribeProgress}%` : "补齐并总结"}</span>
                </button>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </aside>
  );
});
