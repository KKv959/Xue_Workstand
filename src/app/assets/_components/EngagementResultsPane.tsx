"use client";

import { EngagementResearchDetails } from "./EngagementResearchDetails";
import { Download } from "lucide-react";
import { AssetTextList } from "./AssetTextList";
import type { BusyState } from "./asset-view-utils";
import { formatTime } from "./asset-view-utils";
import type { EngagementRecord } from "@/lib/types";

type EngagementResultsPaneProps = {
  busy: BusyState;
  includeDanmaku: boolean;
  previewComments: NonNullable<EngagementRecord["comments"]>["items"];
  resultRecord: EngagementRecord | null;
  onCopyText: (text: string, message: string) => void;
  onExportWord: (record: EngagementRecord) => void;
  onPublishAssetText: (kind: "comments" | "danmaku", items: string[], emptyMessage: string) => void;
};

export function EngagementResultsPane({
  busy,
  includeDanmaku,
  previewComments,
  resultRecord,
  onCopyText,
  onExportWord,
  onPublishAssetText
}: EngagementResultsPaneProps) {
  const activeComments = previewComments.length ? previewComments : resultRecord?.comments?.items || [];
  const activeDanmaku = resultRecord?.danmaku?.items || [];
  const danmakuTexts = activeDanmaku.map((item) => typeof item.timeSec === "number"
    ? `${formatTime(item.timeSec)}\t${item.text}` : item.text);
  const diagnostics = resultRecord?.comments?.diagnostics;
  const generation = diagnostics?.generation;
  const sourceBrief = diagnostics?.sourceBrief;
  const entityGuard = diagnostics?.entityGuard;
  const relatedResearch = diagnostics?.relatedResearch;
  const quarantineDetails = (relatedResearch?.quarantinedSources || [])
    .map((source) => `${source.videoTitle || source.videoId}：${source.reasons.join("；")}`)
    .join("\n");
  const requestedCommentCount = resultRecord?.comments?.requestedCount || resultRecord?.options.commentCount || 0;
  const actualCommentCount = resultRecord?.comments?.items.length || 0;
  const missingCommentCount = Math.max(requestedCommentCount - actualCommentCount, 0);
  const requestedDanmakuCount = resultRecord?.danmaku?.requestedCount || (resultRecord?.options.includeDanmaku ? resultRecord.options.danmakuCount : 0);
  const actualDanmakuCount = resultRecord?.danmaku?.items.length || 0;
  const missingDanmakuCount = Math.max(requestedDanmakuCount - actualDanmakuCount, 0);
  const isGenerating = busy === "generate";
  const reusableCommentKeys = new Set((relatedResearch?.reusableComments || []).map(commentDisplayKey));
  const commentOrigins = activeComments.map((item) => {
    if (item.origin) return item.origin;
    if (!relatedResearch) return undefined;
    return reusableCommentKeys.has(commentDisplayKey(item.text)) ? "reused_hot_comment" as const : "ai_generated" as const;
  });

  return (
    <section className="engagement-result-pane">
      <div className="pane-body engagement-results-pane">
        {generation && !isGenerating ? (
          <div className="engagement-diagnostics">
            <span>
              {generation.mode === "keyword_local"
                ? "关键词生成"
                : generation.batchCount > 0
                  ? `${generation.batchCount} 批 AI 生成`
                  : "原评直出"}
            </span>
            <span>完成 {actualCommentCount || generation.completedCount}/{requestedCommentCount || generation.requestedCount}</span>
            {resultRecord?.comments?.timings ? <span>耗时 {formatDuration(resultRecord.comments.timings.totalMs)}</span> : null}
            {resultRecord?.comments?.timings?.cacheHits.length ? <span>缓存 {resultRecord.comments.timings.cacheHits.length}</span> : null}
            {sourceBrief ? <span>锚点 {sourceBrief.keyFacts.length + sourceBrief.anchorTerms.length}</span> : null}
            {(generation.lowSignalRejectedCount || generation.syntheticRejectedCount || generation.nearDuplicateRejectedCount || generation.repeatedStyleRejectedCount) ? (
              <span>过滤 {(generation.lowSignalRejectedCount || 0) + (generation.syntheticRejectedCount || 0) + (generation.nearDuplicateRejectedCount || 0) + (generation.repeatedStyleRejectedCount || 0)}</span>
            ) : null}
            {generation.entityCorrectedCount ? <span>型号纠错 {generation.entityCorrectedCount}</span> : null}
            {generation.unsupportedEntityRejectedCount ? <span>型号过滤 {generation.unsupportedEntityRejectedCount}</span> : null}
            {generation.transportRejectedCount ? <span>链接污染过滤 {generation.transportRejectedCount}</span> : null}
            {entityGuard?.allowedModels?.length ? <span>型号 {entityGuard.allowedModels.length}</span> : null}
            {typeof generation.nativeEmoteCount === "number" ? <span>含表情 {generation.nativeEmoteCount}</span> : null}
            {relatedResearch?.relatedVideoCount ? <span>相关视频 {relatedResearch.relatedVideoCount}</span> : null}
            {typeof relatedResearch?.targetPlatformCommentCount === "number" ? <span>目标平台可用参考 {relatedResearch.targetPlatformCommentCount}</span> : null}
            {typeof relatedResearch?.freshCommentCount === "number" ? <span>{relatedResearch.review ? "已审可用参考" : "精选表达参考"} {relatedResearch.freshCommentCount}</span> : null}
            {typeof relatedResearch?.matchedLibraryCommentCount === "number" && relatedResearch.matchedLibraryCommentCount > 0
              ? <span>历史语义命中 {relatedResearch.matchedLibraryCommentCount}</span>
              : null}
            {relatedResearch?.relatedCommentCount ? <span>最终参考 {relatedResearch.relatedCommentCount}</span> : null}
            {relatedResearch?.quarantinedVideoCount ? (
              <span title={quarantineDetails || undefined}>人机评论源过滤 {relatedResearch.quarantinedVideoCount}个</span>
            ) : null}
            {relatedResearch?.quarantineClassifierStatus === "fallback" ? (
              <span title={relatedResearch.quarantineClassifierError}>人机复核降级</span>
            ) : null}
            {generation.reusedRelatedCommentCount ? <span>相关原评 {generation.reusedRelatedCommentCount}</span> : null}
            {generation.aiGeneratedCount ? <span>AI 生成 {generation.aiGeneratedCount}</span> : null}
            {generation.outputReview ? <span>历史 AI 审核拒绝 {generation.outputReview.rejectedCount}/{generation.outputReview.reviewedCount}</span> : null}
            {relatedResearch?.sampleLibraryCount ? <span>样本库 {relatedResearch.sampleLibraryCount}</span> : null}
            {relatedResearch?.replySampleCount ? <span>回复讨论 {relatedResearch.replySampleCount}</span> : null}
            {relatedResearch?.sourceStats?.some((source) => source.status !== "completed")
              ? <span title={relatedResearch.sourceStats.filter((source) => source.error).map((source) => source.error).join("；")}>覆盖不完整</span>
              : null}
            {generation.mode === "model_batch" && generation.batchCount > 0 ? <span>模型解析 {generation.parsedCount}</span> : null}
          </div>
        ) : null}
        {relatedResearch && !isGenerating ? <EngagementResearchDetails key={resultRecord?.id} research={relatedResearch} /> : null}
        {resultRecord?.danmaku && !isGenerating ? (
          <div className="engagement-diagnostics">
            <span>B站弹幕</span>
            <span>{resultRecord.danmaku.timingBasis === "none" ? "正文批量生成" : resultRecord.danmaku.timingBasis === "source_segments" ? "语音分段时间" : "文案节奏估时"}</span>
            {resultRecord.danmaku.durationSec ? <span>时长 {formatDuration(resultRecord.danmaku.durationSec * 1000)}</span> : null}
            {typeof resultRecord.danmaku.styleSampleCount === "number" ? <span>真实样本 {resultRecord.danmaku.styleSampleCount}</span> : null}
            {resultRecord.danmaku.styleVideoCount ? <span>标杆视频 {resultRecord.danmaku.styleVideoCount}</span> : null}
            {resultRecord.danmaku.styleTopics?.length ? <span>题材 {resultRecord.danmaku.styleTopics.slice(0, 2).join("/")}</span> : null}
            {typeof resultRecord.danmaku.burstShare === "number" ? <span>爆点成簇</span> : null}
          </div>
        ) : null}
        <AssetTextList
          empty={isGenerating ? "首批评论生成后会直接显示。" : "生成后会在这里显示评论。"}
          items={activeComments.map((item) => item.text)}
          itemOrigins={commentOrigins}
          leadingActions={(
            <button
              aria-busy={busy === "export-word"}
              aria-label={busy === "export-word" ? "正在导出 Word" : "导出 Word"}
              className="btn compact icon-only"
              disabled={!resultRecord || (!activeComments.length && !activeDanmaku.length) || Boolean(busy)}
              onClick={() => resultRecord ? onExportWord(resultRecord) : undefined}
              title={busy === "export-word" ? "正在导出 Word" : "导出 Word"}
              type="button"
            >
              <Download aria-hidden="true" size={16} />
            </button>
          )}
          title={`评论 ${activeComments.length}${missingCommentCount && !isGenerating ? `/${requestedCommentCount}` : ""}${isGenerating && previewComments.length ? " · 生成与保存中" : ""}`}
          onCopy={() => onCopyText(activeComments.map((item) => item.text).join("\n"), "评论已复制。")}
          onPublish={() =>
            onPublishAssetText(
              "comments",
              activeComments.map((item) => item.text),
              "导出评论失败"
            )
          }
          publishDisabled={Boolean(busy)}
          publishing={busy === "feishu-comments"}
        />
        <AssetTextList
          empty={includeDanmaku || activeDanmaku.length ? "生成后会在这里显示弹幕。" : "勾选弹幕后会生成弹幕。"}
          items={danmakuTexts}
          title={`弹幕 ${activeDanmaku.length}${missingDanmakuCount ? `/${requestedDanmakuCount}` : ""}`}
          onCopy={() => onCopyText(danmakuTexts.join("\n"), "弹幕已复制。")}
          onPublish={() =>
            onPublishAssetText(
              "danmaku",
              danmakuTexts,
              "导出弹幕失败"
            )
          }
          publishDisabled={Boolean(busy)}
          publishing={busy === "feishu-danmaku"}
        />
      </div>
    </section>
  );
}

function commentDisplayKey(value: string) {
  return value
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "")
    .toLowerCase()
    .replace(/(?:真没想到|这波可以|有点意思|我先观望|哈哈)+$/g, "")
    .replace(/[啊吧呀呢哦哈]+$/g, "");
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
