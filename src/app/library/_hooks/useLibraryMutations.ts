"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import { deleteAccounts, deleteVideos, saveStyle } from "@/lib/client";
import { invalidateAccountDetail } from "@/lib/detail-cache";
import type { AccountDetail, Platform } from "@/lib/types";
import type { LibraryMessageSetter } from "../_components/library-view-utils";

type ReloadAccountDetail = (options?: { includeStyle?: boolean; force?: boolean }) => Promise<AccountDetail | null>;

type UseLibraryMutationsInput = {
  clearTranscript: () => void;
  closeDeleteDialog: () => void;
  refresh: () => Promise<void>;
  reloadSelectedAccountDetail: ReloadAccountDetail;
  selectedAccount: AccountDetail | null;
  setAccountDetail: Dispatch<SetStateAction<AccountDetail | null>>;
  setAccountManageMode: Dispatch<SetStateAction<boolean>>;
  setBusy: (value: string) => void;
  setMessage: LibraryMessageSetter;
  setSelectedAccountIds: Dispatch<SetStateAction<string[]>>;
  setSelectedVideoIds: Dispatch<SetStateAction<string[]>>;
  setVideoManageMode: Dispatch<SetStateAction<boolean>>;
  styleDraft: string;
};

export function useLibraryMutations({
  clearTranscript,
  closeDeleteDialog,
  refresh,
  reloadSelectedAccountDetail,
  selectedAccount,
  setAccountDetail,
  setAccountManageMode,
  setBusy,
  setMessage,
  setSelectedAccountIds,
  setSelectedVideoIds,
  setVideoManageMode,
  styleDraft
}: UseLibraryMutationsInput) {
  const handleSaveStyle = useCallback(async () => {
    if (!selectedAccount) return;
    setBusy("save-style");
    setMessage("");
    try {
      await saveStyle(selectedAccount.platform, selectedAccount.id, styleDraft);
      setMessage("风格卡已保存。", "success");
      await refresh();
      await reloadSelectedAccountDetail({ includeStyle: true });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败", "error");
    } finally {
      setBusy("");
    }
  }, [refresh, reloadSelectedAccountDetail, selectedAccount, setBusy, setMessage, styleDraft]);

  const handleDeleteSelectedAccounts = useCallback(async (accountIds: string[]) => {
    if (!accountIds.length) return;
    const deletingActiveAccount = Boolean(selectedAccount && accountIds.includes(selectedAccount.id));

    setBusy("account-delete");
    setMessage("");
    try {
      const result = await deleteAccounts(accountIds);
      accountIds.forEach((accountId) => {
        const [platform] = accountId.split(":") as [Platform, string];
        invalidateAccountDetail(platform, accountId);
      });
      setSelectedAccountIds([]);
      setSelectedVideoIds([]);
      setAccountManageMode(false);
      closeDeleteDialog();
      setMessage(`已删除 ${result.deleted.length} 个账号。`, "success");
      await refresh();
      if (deletingActiveAccount) {
        clearTranscript();
        setAccountDetail(null);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "删除账号失败", "error");
    } finally {
      setBusy("");
    }
  }, [
    clearTranscript,
    closeDeleteDialog,
    refresh,
    selectedAccount,
    setAccountDetail,
    setAccountManageMode,
    setBusy,
    setMessage,
    setSelectedAccountIds,
    setSelectedVideoIds
  ]);

  const handleDeleteSelectedVideos = useCallback(async (input: {
    platform: Platform;
    accountId: string;
    videoIds: string[];
    deletingActiveVideo: boolean;
  }) => {
    if (!input.videoIds.length) return;

    setBusy("video-delete");
    setMessage("");
    try {
      const result = await deleteVideos({
        platform: input.platform,
        accountId: input.accountId,
        videoIds: input.videoIds
      });
      if (input.deletingActiveVideo) clearTranscript();
      setSelectedVideoIds([]);
      setVideoManageMode(false);
      closeDeleteDialog();
      setMessage(`已删除 ${result.deleted.length} 条视频。`, "success");
      await refresh();
      await reloadSelectedAccountDetail({ force: true });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "删除视频失败", "error");
    } finally {
      setBusy("");
    }
  }, [
    clearTranscript,
    closeDeleteDialog,
    refresh,
    reloadSelectedAccountDetail,
    setBusy,
    setMessage,
    setSelectedVideoIds,
    setVideoManageMode
  ]);

  return {
    handleDeleteSelectedAccounts,
    handleDeleteSelectedVideos,
    handleSaveStyle
  };
}
