"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getEngagementRecord } from "@/lib/client";
import { engagementSourceKey } from "@/lib/job-scope";
import { extractFirstLinkFromInput } from "@/lib/platform-links";
import type { EngagementRecord, JobRecord, JobStartInput, Platform } from "@/lib/types";
import type { BusyState } from "../_components/asset-view-utils";

type EngagementJobInput = Extract<JobStartInput, { kind: "engagement" }>["input"];

type UseEngagementGenerationInput = {
  activeJobs: JobRecord[];
  commentCount: number;
  danmakuCount: number;
  includeComments: boolean;
  includeDanmaku: boolean;
  onRecordCompleted: (record: EngagementRecord) => void;
  targetPlatform: Platform;
  recentJobs: JobRecord[];
  sourceInput: string;
  startTask: (input: JobStartInput) => Promise<JobRecord>;
  busy: BusyState;
  setBusy: Dispatch<SetStateAction<BusyState>>;
  setNotice: Dispatch<SetStateAction<string>>;
};

export function useEngagementGeneration({
  activeJobs,
  busy,
  commentCount,
  danmakuCount,
  includeComments,
  includeDanmaku,
  onRecordCompleted,
  targetPlatform,
  recentJobs,
  setBusy,
  setNotice,
  sourceInput,
  startTask
}: UseEngagementGenerationInput) {
  const [resultRecord, setResultRecord] = useState<EngagementRecord | null>(null);
  const [activeEngagementJobId, setActiveEngagementJobId] = useState("");
  const handledEngagementJobIdsRef = useRef(new Set<string>());
  const resolvingEngagementJobIdsRef = useRef(new Set<string>());
  const trimmedSource = sourceInput.trim();
  const activeTitle = resultRecord?.title || trimmedSource.slice(0, 32) || "评论生成";
  const currentInput = useMemo(
    () =>
      trimmedSource
        ? buildEngagementJobInput(trimmedSource, {
            includeComments,
            commentCount,
            includeDanmaku,
            danmakuCount,
            targetPlatform
          })
      : null,
    [commentCount, danmakuCount, includeComments, includeDanmaku, targetPlatform, trimmedSource]
  );
  const engagementJobCandidates = useMemo(
    () => [...activeJobs, ...recentJobs].filter((job) => job.kind === "engagement"),
    [activeJobs, recentJobs]
  );

  const engagementJob = useMemo(
    () =>
      findTaskJob(
        engagementJobCandidates,
        activeEngagementJobId,
        "engagement",
        currentInput ? (job) => matchesEngagementScope(job, currentInput) : () => false
      ),
    [activeEngagementJobId, currentInput, engagementJobCandidates]
  );
  const isGenerating = Boolean(engagementJob && (engagementJob.status === "queued" || engagementJob.status === "running"));
  const canGenerate = !busy && !isGenerating && (includeComments || includeDanmaku) && Boolean(trimmedSource);
  const previewResult = isGenerating
    ? engagementJob?.result as { previewComments?: NonNullable<EngagementRecord["comments"]>["items"] } | undefined
    : undefined;
  const generationProgress = isGenerating && engagementJob
    ? {
        stage: engagementJob.stage || "prepare",
        message: engagementJob.message,
        progress: engagementJob.progress
      }
    : null;
  const runningPreviewComments = previewResult?.previewComments || [];
  const previewComments = resultRecord && engagementJob?.scope?.engagementRecordId === resultRecord.id
    ? mergePreviewComments(resultRecord.comments?.items || [], runningPreviewComments)
    : runningPreviewComments;

  useEffect(() => {
    if (!engagementJob) return;
    setActiveEngagementJobId(engagementJob.id);
    if (engagementJob.status === "running" || engagementJob.status === "queued") {
      setBusy("generate");
      return;
    }
    if (handledEngagementJobIdsRef.current.has(engagementJob.id)) return;
    setBusy("");
    if (engagementJob.status === "completed") {
      const result = engagementJob.result as { record?: EngagementRecord } | undefined;
      if (result?.record) {
        handledEngagementJobIdsRef.current.add(engagementJob.id);
        setResultRecord(result.record);
        onRecordCompleted(result.record);
        setNotice(buildSuccessMessage(result.record));
      } else if (engagementJob.resultRef?.id && !resolvingEngagementJobIdsRef.current.has(engagementJob.id)) {
        resolvingEngagementJobIdsRef.current.add(engagementJob.id);
        void getEngagementRecord(engagementJob.resultRef.id, { fresh: true }).then((record) => {
          handledEngagementJobIdsRef.current.add(engagementJob.id);
          setResultRecord(record);
          onRecordCompleted(record);
          setNotice(buildSuccessMessage(record));
        }).catch((error) => {
          setNotice(error instanceof Error ? error.message : "任务已完成，但读取互动素材结果失败。");
        });
      } else {
        setNotice("任务已完成，但暂未收到互动素材结果，正在等待任务同步。");
      }
      return;
    }
    handledEngagementJobIdsRef.current.add(engagementJob.id);
    if (engagementJob.status === "failed") {
      setNotice(engagementJob.error || "生成评论失败，请检查输入和模型配置。");
    }
  }, [engagementJob, onRecordCompleted, setBusy, setNotice]);

  const handleGenerate = useCallback(async () => {
    if (!includeComments && !includeDanmaku) {
      setNotice("请至少选择评论或弹幕。");
      return;
    }

    const rawSource = trimmedSource;
    if (!rawSource) {
      setNotice("请先输入链接或文案。");
      return;
    }

    const input = buildEngagementJobInput(rawSource, {
      includeComments,
      commentCount,
      includeDanmaku,
      danmakuCount,
      targetPlatform
    });

    setBusy("generate");
    setNotice("");
    setResultRecord(null);
    try {
      const job = await startTask({
        kind: "engagement",
        title: "生成评论素材",
        inputSummary: input.sourceType === "url" ? input.url : rawSource.slice(0, 48),
        href: "/assets",
        input
      });
      setActiveEngagementJobId(job.id);
    } catch (err) {
      setBusy("");
      setNotice(err instanceof Error ? err.message : "生成评论失败，请检查输入和模型配置。");
    }
  }, [
    commentCount,
    danmakuCount,
    includeComments,
    includeDanmaku,
    setBusy,
    setNotice,
    setResultRecord,
    startTask,
    targetPlatform,
    trimmedSource
  ]);

  return {
    canGenerate,
    activeTitle,
    generationProgress,
    handleGenerate,
    previewComments,
    resultRecord,
    setResultRecord
  };
}

function buildSuccessMessage(record: EngagementRecord) {
  const commentCount = record.comments?.items.length || 0;
  const requestedCommentCount = record.comments?.requestedCount || record.options.commentCount;
  const danmakuCount = record.danmaku?.items.length || 0;
  const requestedDanmakuCount = record.danmaku?.requestedCount || record.options.danmakuCount;
  const commentLabel = requestedCommentCount && commentCount < requestedCommentCount
    ? `${commentCount}/${requestedCommentCount} 条评论（自动补齐已结束）`
    : `${commentCount} 条评论`;
  const danmakuLabel = requestedDanmakuCount && danmakuCount < requestedDanmakuCount
    ? `${danmakuCount}/${requestedDanmakuCount} 条弹幕（自动补齐已结束）`
    : `${danmakuCount} 条弹幕`;
  if (commentCount && danmakuCount) return `已生成 ${commentLabel}和 ${danmakuLabel}。`;
  if (commentCount) return `已生成 ${commentLabel}。`;
  return `已生成 ${danmakuLabel}。`;
}

function buildEngagementJobInput(
  rawSource: string,
  options: Pick<Extract<EngagementJobInput, { sourceType: "text" }>, "includeComments" | "commentCount" | "includeDanmaku" | "danmakuCount" | "targetPlatform">
): EngagementJobInput {
  const extractedUrl = extractFirstLinkFromInput(rawSource, { kind: "video" });

  if (extractedUrl) {
    return {
      sourceType: "url",
      url: extractedUrl,
      includeComments: options.includeComments,
      commentCount: options.commentCount,
      includeDanmaku: options.includeDanmaku,
      danmakuCount: options.danmakuCount
    };
  }

  return {
    sourceType: "text",
    text: rawSource,
    ...options
  };
}

function matchesEngagementScope(job: JobRecord, input: EngagementJobInput) {
  if (input.sourceType === "draft") return Boolean(job.scope?.targetType === "draft" && job.scope.draftId === input.draftId);
  if (input.sourceType === "record") {
    return Boolean(job.scope?.targetType === "engagement" && job.scope.engagementRecordId === input.recordId);
  }
  return job.scope?.targetType === input.sourceType && job.scope.sourceKey === engagementSourceKey(input);
}

export function findTaskJob(
  jobs: JobRecord[],
  jobId: string,
  kind: JobRecord["kind"],
  matchesScope: (job: JobRecord) => boolean
) {
  const tracked = jobs.find((job) => job.id === jobId && job.kind === kind);
  if (tracked && isActiveJob(tracked)) return tracked;
  const latest = jobs.filter((job) => job.kind === kind && matchesScope(job)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return jobs.find((job) => job.kind === kind && isActiveJob(job) && matchesScope(job))
    || (tracked && latest && latest.createdAt > tracked.createdAt ? latest : tracked)
    || null;
}

function isActiveJob(job: JobRecord) {
  return job.status === "queued" || job.status === "running";
}

function mergePreviewComments(
  existing: NonNullable<EngagementRecord["comments"]>["items"],
  preview: NonNullable<EngagementRecord["comments"]>["items"]
) {
  const seen = new Set(existing.map((item) => item.text.replace(/\s+/g, "").toLowerCase()));
  return [...existing, ...preview.filter((item) => {
    const key = item.text.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}
