"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTranscript, restoreTranscriptVersion, saveTranscript } from "@/lib/client";
import { getCachedTranscript, invalidateTranscriptCache, rememberTranscript } from "@/lib/transcript-cache";
import type { AccountDetail, TranscriptVersion, VideoListItem } from "@/lib/types";
import { canReadTranscript, makePreview, type LibraryMessageSetter } from "../_components/library-view-utils";

type ReloadAccountDetail = (options?: { includeStyle?: boolean; force?: boolean }) => Promise<AccountDetail | null>;

type UseLibraryTranscriptActionsInput = {
  refresh: () => Promise<void>;
  reloadSelectedAccountDetail: ReloadAccountDetail;
  selectedAccount: AccountDetail | null;
  selectedVideo: VideoListItem | null;
  setMessage: LibraryMessageSetter;
  onOpenEditor: () => void;
  onSaved: () => void;
};

export function useLibraryTranscriptActions({
  refresh,
  reloadSelectedAccountDetail,
  selectedAccount,
  selectedVideo,
  setMessage,
  onOpenEditor,
  onSaved
}: UseLibraryTranscriptActionsInput) {
  const [transcript, setTranscript] = useState("");
  const [transcriptRevision, setTranscriptRevision] = useState<string | null>(null);
  const [transcriptVersions, setTranscriptVersions] = useState<TranscriptVersion[]>([]);
  const [transcriptVideoId, setTranscriptVideoId] = useState("");
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState("");
  const requestSeqRef = useRef(0);
  const loadedVersionRef = useRef<string | undefined>(undefined);
  const draftDirtyRef = useRef(false);
  const pendingRef = useRef<Promise<boolean> | null>(null);
  const [transcriptRestoring, setTranscriptRestoring] = useState(false);
  const [transcriptStale, setTranscriptStale] = useState(false);

  const [transcriptComplete, setTranscriptComplete] = useState(false);
  const selectionKey = `${selectedAccount?.platform}|${selectedAccount?.id}|${selectedVideo?.id}`;
  const selectedVideoHasTranscript = canReadTranscript(selectedVideo);
  const activeTranscript = selectedVideo && transcriptVideoId === selectionKey ? transcript : "";
  const transcriptPreview = useMemo(() => makePreview(activeTranscript), [activeTranscript]);

  const clearTranscript = useCallback(() => {
    requestSeqRef.current += 1;
    pendingRef.current = null;
    setTranscriptLoading(false);
    setTranscriptError("");
    setTranscript("");
    setTranscriptRevision(null);
    setTranscriptVersions([]);
    setTranscriptVideoId("");
    setTranscriptStale(false);
    setTranscriptComplete(false);
    draftDirtyRef.current = false;
    loadedVersionRef.current = undefined;
  }, []);

  const invalidateTranscript = useCallback(() => {
    invalidateTranscriptCache(selectedAccount?.platform, selectedAccount?.id, selectedVideo?.id);
    requestSeqRef.current += 1;
    pendingRef.current = null;
    if (draftDirtyRef.current) {
      setTranscriptError("原稿已有更新，当前未保存修改已保留；保存时会校验版本，请先备份修改再重新打开最新原稿。");
      return;
    }
    setTranscriptStale(true);
  }, [selectedAccount?.platform, selectedAccount?.id, selectedVideo?.id]);

  useEffect(() => {
    clearTranscript();
    return () => { requestSeqRef.current += 1; pendingRef.current = null; };
  }, [clearTranscript, selectedAccount?.id, selectedAccount?.platform, selectedVideo?.id]);

  const accountId = selectedAccount?.id;
  const platform = selectedAccount?.platform;
  const videoId = selectedVideo?.id;
  const version = selectedVideo?.transcriptRevision;
  const loadSelectedTranscript = useCallback(async (requireFull = false) => {
    if (!accountId || !platform || !videoId || !selectedVideoHasTranscript) return false;
    if (transcriptVideoId === selectionKey && !transcriptStale && (!requireFull || transcriptComplete) && (draftDirtyRef.current || loadedVersionRef.current === version)) return true;
    if (pendingRef.current) return pendingRef.current;

    const requestSeq = ++requestSeqRef.current;
    setTranscriptLoading(true);
    setTranscriptError("");
    const request = (async () => {
      try {
        const cached = !transcriptStale ? getCachedTranscript({ platform, accountId, videoId, version }) : null;
        const result = cached && (!requireFull || cached.complete) ? await Promise.resolve(cached) : await getTranscript({ platform, accountId, videoId, version });
        // 快速切换视频时，迟到的响应不能覆盖新选中项或打开错误原稿。
        if (requestSeq !== requestSeqRef.current) return false;
        if ("error" in result && result.error) throw new Error(String(result.error));
        loadedVersionRef.current = version;
        draftDirtyRef.current = false;
        setTranscript(result.transcript);
        setTranscriptRevision(result.revision);
        setTranscriptVersions(result.versions);
        setTranscriptVideoId(selectionKey);
        setTranscriptComplete("complete" in result ? Boolean(result.complete) : true);
        setTranscriptStale(false);
        return true;
      } catch (err) {
        if (requestSeq !== requestSeqRef.current) return false;
        const message = err instanceof Error ? err.message : "读取转写稿失败，请重试。";
        setTranscriptError(message);
        setMessage(message, "error");
        return false;
      } finally {
        if (requestSeq === requestSeqRef.current) {
          pendingRef.current = null;
          setTranscriptLoading(false);
        }
      }
    })();
    pendingRef.current = request;
    return request;
  }, [accountId, platform, videoId, selectedVideoHasTranscript, setMessage, transcriptStale, transcriptVideoId, transcriptComplete, selectionKey, version]);

  useEffect(() => {
    void loadSelectedTranscript();
  }, [loadSelectedTranscript]);

  const openTranscriptModal = useCallback(async () => {
    if (!selectedVideo) return;
    if (selectedVideoHasTranscript) {
      const loaded = await loadSelectedTranscript(true);
      if (!loaded) return;
    }
    onOpenEditor();
  }, [loadSelectedTranscript, onOpenEditor, selectedVideo, selectedVideoHasTranscript]);

  const updateTranscriptDraft = useCallback((value: string) => {
    draftDirtyRef.current = true;
    setTranscript(value);
    setTranscriptVideoId(selectionKey);
  }, [selectionKey]);

  const handleSaveTranscript = useCallback(async (setBusy: (value: string) => void) => {
    if (!selectedAccount || !selectedVideo) return;
    setBusy("save-transcript");
    setMessage("");
    try {
      const result = await saveTranscript({
        platform: selectedAccount.platform,
        accountId: selectedAccount.id,
        videoId: selectedVideo.id,
        transcript,
        expectedRevision: transcriptRevision
      });
      draftDirtyRef.current = false;
      setTranscript(result.transcript);
      setTranscriptRevision(result.revision);
      setTranscriptVersions(result.versions);
      rememberTranscript({ platform: selectedAccount.platform, accountId: selectedAccount.id, videoId: selectedVideo.id }, { ...result, complete: true });
      setTranscriptVideoId(selectionKey);
      setTranscriptComplete(true);
      setTranscriptStale(false);
      setMessage(result.previousVersionCreated ? "转写稿已保存，旧稿已归档到历史版本。" : "转写稿已保存。", "success");
      onSaved();
      await refresh();
      await reloadSelectedAccountDetail({ force: true });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存转写稿失败", "error");
    } finally {
      setBusy("");
    }
  }, [onSaved, refresh, reloadSelectedAccountDetail, selectedAccount, selectedVideo, setMessage, transcript, transcriptRevision, selectionKey]);

  const handleRestoreTranscript = useCallback(async (versionId: string) => {
    if (!selectedAccount || !selectedVideo || !versionId) return;
    setTranscriptRestoring(true);
    setMessage("");
    try {
      const result = await restoreTranscriptVersion({
        platform: selectedAccount.platform,
        accountId: selectedAccount.id,
        videoId: selectedVideo.id,
        versionId,
        expectedRevision: transcriptRevision
      });
      draftDirtyRef.current = false;
      setTranscript(result.transcript);
      setTranscriptRevision(result.revision);
      setTranscriptVersions(result.versions);
      rememberTranscript({ platform: selectedAccount.platform, accountId: selectedAccount.id, videoId: selectedVideo.id }, { ...result, complete: true });
      setTranscriptVideoId(selectionKey);
      setTranscriptComplete(true);
      setTranscriptStale(false);
      setMessage("已恢复转写历史版本。", "success");
      await refresh();
      await reloadSelectedAccountDetail({ force: true });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "恢复转写历史版本失败", "error");
    } finally {
      setTranscriptRestoring(false);
    }
  }, [refresh, reloadSelectedAccountDetail, selectedAccount, selectedVideo, setMessage, transcriptRevision, selectionKey]);

  return {
    activeTranscript,
    clearTranscript,
    handleSaveTranscript,
    handleRestoreTranscript,
    invalidateTranscript,
    openTranscriptModal,
    selectedVideoHasTranscript,
    transcriptLoading,
    transcriptError,
    transcriptRestoring,
    transcriptPreview,
    transcriptVersions,
    updateTranscriptDraft
  };
}
