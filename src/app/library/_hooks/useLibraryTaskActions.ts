"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { AccountDetail, JobRecord, JobStartInput, VideoListItem } from "@/lib/types";
import type { LibraryMessageSetter } from "../_components/library-view-utils";

type ReloadAccountDetail = (options?: { includeStyle?: boolean; force?: boolean }) => Promise<AccountDetail | null>;

type UseLibraryTaskActionsInput = {
  refresh: () => Promise<void>;
  reloadSelectedAccountDetail: ReloadAccountDetail;
  selectedAccount: AccountDetail | null;
  selectedVideo: VideoListItem | null;
  setActiveBatchJobId: Dispatch<SetStateAction<string>>;
  setActiveStyleJobId: Dispatch<SetStateAction<string>>;
  setActiveTranscribeJobId: Dispatch<SetStateAction<string>>;
  setBusy: (value: string) => void;
  setMessage: LibraryMessageSetter;
  setStyleProgress: Dispatch<SetStateAction<number>>;
  setStyleStage: Dispatch<SetStateAction<string>>;
  setTranscribeProgress: Dispatch<SetStateAction<number>>;
  setTranscribeStage: Dispatch<SetStateAction<string>>;
  startTask: (input: JobStartInput) => Promise<JobRecord>;
};

export function useLibraryTaskActions({
  refresh,
  reloadSelectedAccountDetail,
  selectedAccount,
  selectedVideo,
  setActiveBatchJobId,
  setActiveStyleJobId,
  setActiveTranscribeJobId,
  setBusy,
  setMessage,
  setStyleProgress,
  setStyleStage,
  setTranscribeProgress,
  setTranscribeStage,
  startTask
}: UseLibraryTaskActionsInput) {
  const handleGenerateStyle = useCallback(async () => {
    if (!selectedAccount) return;
    setBusy("style");
    setMessage("");
    setStyleProgress(8);
    setStyleStage("正在读取账号转写样本");
    try {
      const job = await startTask({
        kind: "account-style",
        title: "生成账号风格卡",
        inputSummary: selectedAccount.name,
        href: "/library",
        input: {
          platform: selectedAccount.platform,
          accountId: selectedAccount.id,
          force: true
        }
      });
      setActiveStyleJobId(job.id);
      setStyleStage(job.message);
      setStyleProgress(job.progress);
      setMessage("账号风格卡已在后台开始生成，可以切换到其他模块。");
    } catch (err) {
      setActiveStyleJobId("");
      setStyleStage("任务启动失败");
      setStyleProgress(0);
      setBusy("");
      setMessage(err instanceof Error ? err.message : "自动总结失败", "error");
    }
  }, [selectedAccount, setActiveStyleJobId, setBusy, setMessage, setStyleProgress, setStyleStage, startTask]);

  const handleTranscribe = useCallback(async () => {
    if (!selectedAccount || !selectedVideo) return;
    setBusy("transcribe");
    setTranscribeProgress(12);
    setTranscribeStage("正在检查字幕和媒体");
    setMessage("");
    try {
      const job = await startTask({
        kind: "transcribe-video",
        title: "转写视频",
        inputSummary: selectedVideo.title,
        href: "/library",
        input: {
          platform: selectedAccount.platform,
          accountId: selectedAccount.id,
          videoId: selectedVideo.id,
          allowRemoteDownload: true
        }
      });
      setActiveTranscribeJobId(job.id);
      setTranscribeStage(job.message);
      setTranscribeProgress(job.progress);
      setMessage("转写稿已在后台开始生成，可以切换到其他模块。");
    } catch (err) {
      const message = err instanceof Error ? err.message : "转写失败";
      setActiveTranscribeJobId("");
      setTranscribeStage("任务启动失败");
      setTranscribeProgress(0);
      setBusy("");
      setMessage(message, "error");
      try {
        await refresh();
        await reloadSelectedAccountDetail({ force: true });
      } catch (refreshErr) {
        setMessage(`${message}；刷新页面状态失败：${refreshErr instanceof Error ? refreshErr.message : "请手动刷新后再试。"}`, "error");
      }
    }
  }, [
    refresh,
    reloadSelectedAccountDetail,
    selectedAccount,
    selectedVideo,
    setActiveTranscribeJobId,
    setBusy,
    setMessage,
    setTranscribeProgress,
    setTranscribeStage,
    startTask
  ]);

  const handleBatchTranscribe = useCallback(async (options: { updateStyle?: boolean; videoIds?: string[] } = {}) => {
    if (!selectedAccount) return;
    const updateStyle = Boolean(options.updateStyle);
    const selectedCount = options.videoIds?.length || 0;
    setBusy(updateStyle ? "batch-style" : "batch");
    setTranscribeProgress(8);
    setTranscribeStage("正在读取候选视频");
    setMessage("");
    try {
      const job = await startTask({
        kind: "batch-transcribe",
        title: updateStyle ? "批量转写并更新风格" : "批量转写",
        inputSummary: `${selectedAccount.name} · ${selectedCount ? `所选 ${selectedCount} 条` : "全部待转写视频"}`,
        href: "/library",
        input: {
          platform: selectedAccount.platform,
          accountId: selectedAccount.id,
          limit: "all",
          videoIds: options.videoIds,
          updateStyle
        }
      });
      setActiveBatchJobId(job.id);
      setTranscribeStage(job.message);
      setTranscribeProgress(job.progress);
      setMessage("批量转写已在后台开始，可以切换到其他模块。");
    } catch (err) {
      const message = err instanceof Error ? err.message : "批量转写失败";
      setActiveBatchJobId("");
      setTranscribeStage("任务启动失败");
      setTranscribeProgress(0);
      setBusy("");
      setMessage(message, "error");
      try {
        await refresh();
        await reloadSelectedAccountDetail({ force: true });
      } catch (refreshErr) {
        setMessage(`${message}；刷新页面状态失败：${refreshErr instanceof Error ? refreshErr.message : "请手动刷新后再试。"}`, "error");
      }
    }
  }, [
    refresh,
    reloadSelectedAccountDetail,
    selectedAccount,
    setActiveBatchJobId,
    setBusy,
    setMessage,
    setTranscribeProgress,
    setTranscribeStage,
    startTask
  ]);

  const generateBatchStyle = useCallback(() => {
    void handleBatchTranscribe({ updateStyle: true });
  }, [handleBatchTranscribe]);

  return {
    generateBatchStyle,
    handleBatchTranscribe,
    handleGenerateStyle,
    handleTranscribe
  };
}
