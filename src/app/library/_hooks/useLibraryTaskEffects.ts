"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { StyleGenerationResponse } from "@/lib/client";
import { invalidateAccountDetail } from "@/lib/detail-cache";
import { formatJobErrorMessage } from "@/lib/job-messages";
import type { AccountDetail, BatchTranscribeResult, JobRecord, VideoListItem } from "@/lib/types";
import type { LibraryMessageSetter } from "../_components/library-view-utils";

type ReloadAccountDetail = (options?: { includeStyle?: boolean; force?: boolean }) => Promise<AccountDetail | null>;

type UseLibraryTaskEffectsInput = {
  activeJobs: JobRecord[];
  recentJobs: JobRecord[];
  reloadSelectedAccountDetail: ReloadAccountDetail;
  selectedAccount: AccountDetail | null;
  selectedVideo: VideoListItem | null;
  invalidateTranscript: () => void;
  setAccountDetail: Dispatch<SetStateAction<AccountDetail | null>>;
  setMessage: LibraryMessageSetter;
  setStyleDraft: Dispatch<SetStateAction<string>>;
};

export function useLibraryTaskEffects({
  activeJobs,
  recentJobs,
  reloadSelectedAccountDetail,
  selectedAccount,
  selectedVideo,
  invalidateTranscript,
  setAccountDetail,
  setMessage,
  setStyleDraft
}: UseLibraryTaskEffectsInput) {
  const [busy, setBusy] = useState("");
  const [transcribeProgress, setTranscribeProgress] = useState(0);
  const [transcribeStage, setTranscribeStage] = useState("");
  const [styleProgress, setStyleProgress] = useState(0);
  const [styleStage, setStyleStage] = useState("");
  const [activeStyleJobId, setActiveStyleJobId] = useState("");
  const [activeTranscribeJobId, setActiveTranscribeJobId] = useState("");
  const [activeBatchJobId, setActiveBatchJobId] = useState("");
  const handledLibraryJobsRef = useRef<Set<string>>(new Set());
  const syncedBatchDataRevisionRef = useRef<Map<string, number>>(new Map());

  const trackedJobs = useMemo(() => [...activeJobs, ...recentJobs], [activeJobs, recentJobs]);
  const accountStyleJob = useMemo(
    () => findTaskJob(trackedJobs, activeStyleJobId, "account-style", (job) => job.scope?.accountId === selectedAccount?.id),
    [activeStyleJobId, selectedAccount?.id, trackedJobs]
  );
  const accountStyleJobIdMismatch = useMemo(
    () => hasMismatchedTrackedJob(trackedJobs, activeStyleJobId, "account-style", (job) => job.scope?.accountId === selectedAccount?.id),
    [activeStyleJobId, selectedAccount?.id, trackedJobs]
  );
  const transcribeJob = useMemo(
    () =>
      findTaskJob(
        trackedJobs,
        activeTranscribeJobId,
        "transcribe-video",
        (job) => job.scope?.accountId === selectedAccount?.id && job.scope?.videoId === selectedVideo?.id
      ),
    [activeTranscribeJobId, selectedAccount?.id, selectedVideo?.id, trackedJobs]
  );
  const transcribeJobIdMismatch = useMemo(
    () =>
      hasMismatchedTrackedJob(
        trackedJobs,
        activeTranscribeJobId,
        "transcribe-video",
        (job) => job.scope?.accountId === selectedAccount?.id && job.scope?.videoId === selectedVideo?.id
      ),
    [activeTranscribeJobId, selectedAccount?.id, selectedVideo?.id, trackedJobs]
  );
  const batchJob = useMemo(
    () => findTaskJob(trackedJobs, activeBatchJobId, "batch-transcribe", (job) => job.scope?.accountId === selectedAccount?.id),
    [activeBatchJobId, selectedAccount?.id, trackedJobs]
  );
  const batchJobIdMismatch = useMemo(
    () => hasMismatchedTrackedJob(trackedJobs, activeBatchJobId, "batch-transcribe", (job) => job.scope?.accountId === selectedAccount?.id),
    [activeBatchJobId, selectedAccount?.id, trackedJobs]
  );

  useEffect(() => {
    if (busy === "style" && accountStyleJobIdMismatch) {
      setActiveStyleJobId("");
      setBusy("");
    }
    if (busy === "transcribe" && transcribeJobIdMismatch) {
      setActiveTranscribeJobId("");
      setBusy("");
    }
    if ((busy === "batch" || busy === "batch-style") && batchJobIdMismatch) {
      setActiveBatchJobId("");
      setBusy("");
    }
  }, [accountStyleJobIdMismatch, batchJobIdMismatch, busy, transcribeJobIdMismatch]);

  useEffect(() => {
    if (!accountStyleJob) return;
    setActiveStyleJobId(accountStyleJob.id);
    setStyleStage(accountStyleJob.message || "正在生成账号风格卡");
    setStyleProgress(accountStyleJob.progress || 0);
    if (accountStyleJob.partialText) setStyleDraft(accountStyleJob.partialText);
    if (accountStyleJob.status === "running" || accountStyleJob.status === "queued") {
      setBusy("style");
      return;
    }
    if (handledLibraryJobsRef.current.has(accountStyleJob.id)) return;
    handledLibraryJobsRef.current.add(accountStyleJob.id);
    setBusy("");
    if (accountStyleJob.status === "completed") {
      const result = accountStyleJob.result as StyleGenerationResponse | undefined;
      if (result?.style) {
        invalidateAccountDetail();
        setStyleDraft(result.style);
        setAccountDetail((current) => current ? { ...current, style: result.style } : current);
      }
      setStyleStage("风格卡已生成");
      setStyleProgress(100);
      setMessage(
        result?.cached
          ? "样本未变化，已复用现有风格卡。"
          : result?.fallback
          ? `已降级生成风格卡：${result.fallbackReason || "模型没有返回可用内容，已用本地模板生成，可继续编辑。"}`
          : result?.generationMode === "incremental"
          ? "已根据新增/变化样本增量更新风格卡。"
          : "已自动总结风格卡。",
        result?.fallback ? "warning" : "success"
      );
      return;
    }
    if (accountStyleJob.status === "failed") {
      setStyleStage("生成失败");
      setStyleProgress(100);
      setMessage(accountStyleJob.error || "自动总结失败", "error");
      return;
    }
    if (accountStyleJob.status === "cancelled") {
      setStyleStage("已停止");
      setMessage("已停止账号风格卡生成。");
    }
  }, [accountStyleJob, setAccountDetail, setMessage, setStyleDraft]);

  useEffect(() => {
    if (!transcribeJob) return;
    setActiveTranscribeJobId(transcribeJob.id);
    setTranscribeStage(transcribeJob.message || "正在转写视频");
    setTranscribeProgress(transcribeJob.progress || 0);
    if (transcribeJob.status === "running" || transcribeJob.status === "queued") {
      setBusy("transcribe");
      return;
    }
    if (handledLibraryJobsRef.current.has(transcribeJob.id)) return;
    handledLibraryJobsRef.current.add(transcribeJob.id);
    setBusy("");
    if (transcribeJob.status === "completed") {
      invalidateTranscript();
      void reloadSelectedAccountDetail({ force: true });
      setTranscribeStage("转写稿已生成");
      setTranscribeProgress(100);
      setMessage("转写完成。", "success");
      return;
    }
    if (transcribeJob.status === "failed") {
      setTranscribeStage("转写失败");
      setTranscribeProgress(100);
      setMessage(formatJobErrorMessage(transcribeJob.error || "转写失败"), "error");
      return;
    }
    if (transcribeJob.status === "cancelled") {
      setTranscribeStage("已停止");
      setMessage("已停止当前转写任务。");
    }
  }, [invalidateTranscript, reloadSelectedAccountDetail, setMessage, transcribeJob]);

  useEffect(() => {
    if (!batchJob) return;
    setActiveBatchJobId(batchJob.id);
    setTranscribeStage(batchJob.message || "正在批量转写");
    setTranscribeProgress(batchJob.progress || 0);
    const dataRevision = batchJob.dataRevision || 0;
    const shouldSyncSavedData =
      batchJob.dataChange?.resource === "library-account" &&
      dataRevision > (syncedBatchDataRevisionRef.current.get(batchJob.id) || 0);
    if (shouldSyncSavedData) {
      syncedBatchDataRevisionRef.current.set(batchJob.id, dataRevision);
      invalidateTranscript();
      invalidateAccountDetail(selectedAccount?.platform, selectedAccount?.id);
      void reloadSelectedAccountDetail({ force: true });
    }
    if (batchJob.status === "running" || batchJob.status === "queued") {
      setBusy(batchJob.title.includes("更新风格") ? "batch-style" : "batch");
      return;
    }
    if (handledLibraryJobsRef.current.has(batchJob.id)) return;
    handledLibraryJobsRef.current.add(batchJob.id);
    setBusy("");
    if (batchJob.status === "completed") {
      const result = batchJob.result as BatchTranscribeResult | undefined;
      invalidateTranscript();
      if (result?.style) {
        invalidateAccountDetail();
        setStyleDraft(result.style);
        setAccountDetail((current) => current ? { ...current, style: result.style } : current);
      }
      if (!shouldSyncSavedData) void reloadSelectedAccountDetail({ force: true });
      setTranscribeStage("批量任务已完成");
      setTranscribeProgress(100);
      setMessage(
        result ? summarizeBatchTranscribeResult(result) : "批量转写完成。",
        result && (result.failed > 0 || result.fallback || result.styleError) ? "warning" : "success"
      );
      return;
    }
    if (batchJob.status === "failed") {
      setTranscribeStage("批量任务失败");
      setTranscribeProgress(100);
      setMessage(batchJob.error || "批量转写失败", "error");
      return;
    }
    if (batchJob.status === "cancelled") {
      setTranscribeStage("已停止");
      setMessage("已停止批量任务。");
    }
  }, [batchJob, invalidateTranscript, reloadSelectedAccountDetail, selectedAccount?.id, selectedAccount?.platform, setAccountDetail, setMessage, setStyleDraft]);

  return {
    busy,
    setActiveBatchJobId,
    setActiveStyleJobId,
    setActiveTranscribeJobId,
    setBusy,
    setStyleProgress,
    setStyleStage,
    setTranscribeProgress,
    setTranscribeStage,
    styleProgress,
    styleStage,
    transcribeProgress,
    transcribeStage
  };
}

function summarizeBatchTranscribeResult(result: BatchTranscribeResult) {
  const timingSummary = summarizeBatchTranscribeTimings(result);
  const baseMessage = `批量转写完成：新增转写 ${result.completed}，跳过 ${result.skipped}，失败 ${result.failed}。${timingSummary ? ` ${timingSummary}` : ""}`;
  if (!result.styleUpdated && !result.styleError && !result.style) return baseMessage;
  if (result.styleUpdated) {
    return result.fallback
      ? `${baseMessage} 风格卡已降级更新：${result.fallbackReason || "模型没有返回可用内容，已用本地模板生成，可继续编辑。"}`
      : `${baseMessage} 风格卡已同步更新。`;
  }
  if (result.styleError) return `${baseMessage} 风格卡未更新：${result.styleError}`;
  return `${baseMessage} 风格卡未更新。`;
}

function summarizeBatchTranscribeTimings(result: BatchTranscribeResult) {
  const transcribeTotal = result.timings?.find((item) => item.stage === "transcribe-phase-total")?.ms;
  const mediaPreload = result.timings?.find((item) => item.stage === "douyin-preload-media")?.ms;
  const completedTimings = result.results
    .map((item) => item.timings?.find((timing) => timing.stage === "total")?.ms || 0)
    .filter((ms) => ms > 0);
  const maxVideoMs = completedTimings.length ? Math.max(...completedTimings) : 0;
  const parts = [
    transcribeTotal ? `转写阶段 ${formatDuration(transcribeTotal)}` : "",
    mediaPreload ? `媒体预取 ${formatDuration(mediaPreload)}` : "",
    maxVideoMs ? `最慢单条 ${formatDuration(maxVideoMs)}` : ""
  ].filter(Boolean);
  return parts.length ? `耗时：${parts.join("，")}。` : "";
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function findTaskJob(
  jobs: JobRecord[],
  jobId: string,
  kind: JobRecord["kind"],
  matchesScope: (job: JobRecord) => boolean
) {
  if (jobId) {
    const tracked = jobs.find((job) => job.id === jobId && job.kind === kind);
    if (tracked && matchesScope(tracked)) return tracked;
  }

  return jobs.find((job) => job.kind === kind && isActiveJob(job) && matchesScope(job)) || null;
}

function hasMismatchedTrackedJob(
  jobs: JobRecord[],
  jobId: string,
  kind: JobRecord["kind"],
  matchesScope: (job: JobRecord) => boolean
) {
  if (!jobId) return false;
  const tracked = jobs.find((job) => job.id === jobId && job.kind === kind);
  return Boolean(tracked && !matchesScope(tracked));
}

function isActiveJob(job: JobRecord) {
  return job.status === "queued" || job.status === "running";
}
