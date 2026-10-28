"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AccountDetail, AccountListItem } from "@/lib/types";
import { getPrimaryMetric, type VideoSortMode } from "../_components/library-view-utils";

import { filterLibraryAccounts, selectLibraryVideos, resolveEffectiveVideoSortMode, defaultSortDirection, type VideoStatusFilter } from "@/lib/library-selection";
import { updateLibraryUrl } from "../_components/library-url";
export type { SortDirection, VideoStatusFilter } from "@/lib/library-selection";
type LibraryMobileView = "accounts" | "videos" | "detail";

export function useLibraryAccountSelection(accounts: AccountListItem[]) {
  const searchParams = useSearchParams();
  const [accountManageMode, setAccountManageMode] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);

  const accountFilter = searchParams.get("q") || "";
  const requestedAccountId = searchParams.get("account") || "";

  const filteredAccounts = useMemo(() => filterLibraryAccounts(accounts, accountFilter), [accountFilter, accounts]);

  const selectedAccountMeta = useMemo(
    () => filteredAccounts.find((account) => account.id === requestedAccountId) || filteredAccounts[0] || null,
    [filteredAccounts, requestedAccountId]
  );

  const replaceParams = updateLibraryUrl;

  useEffect(() => {
    if (!accounts.length && requestedAccountId) return;
    const effectiveId = selectedAccountMeta?.id || "";
    if (requestedAccountId === effectiveId) return;
    replaceParams({ account: effectiveId || null, video: null });
  }, [accounts.length, replaceParams, requestedAccountId, selectedAccountMeta?.id]);

  useEffect(() => {
    const visibleIds = new Set(filteredAccounts.map((account) => account.id));
    setSelectedAccountIds((current) => current.filter((accountId) => visibleIds.has(accountId)));
    if (!filteredAccounts.length) setAccountManageMode(false);
  }, [filteredAccounts]);

  const selectAccount = useCallback((accountId: string, mobileView?: LibraryMobileView) => {
    updateLibraryUrl({
      account: accountId || null,
      video: null,
      ...(mobileView ? { mv: mobileView === "accounts" ? null : mobileView } : {})
    }, "push");
  }, []);

  const toggleManagedAccount = useCallback((accountId: string) => {
    setSelectedAccountIds((current) =>
      current.includes(accountId) ? current.filter((id) => id !== accountId) : [...current, accountId]
    );
  }, []);

  const toggleAccountManage = useCallback(() => {
    setAccountManageMode((current) => !current);
    setSelectedAccountIds([]);
  }, []);

  return {
    accountFilter,
    accountManageMode,
    filteredAccounts,
    requestedAccountId,
    selectedAccountIds,
    selectedAccountMeta,
    clearAccountFilters: () => replaceParams({ q: null, platform: null, accountStatus: null, accountSort: null }),
    selectAccount,
    setAccountFilter: (value: string) => replaceParams({ q: value || null }),
    setAccountManageMode,
    setSelectedAccountIds,
    toggleAccountManage,
    toggleManagedAccount
  };
}

export function useLibraryVideoSelection(selectedAccount: AccountDetail | null) {
  const searchParams = useSearchParams();
  const [videoManageMode, setVideoManageMode] = useState(false);
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);

  const query = searchParams.toString();
  const { videoFilter, videoStatusFilter, sortDirection, effectiveSortMode, requestedVideoId, sortedVideos, selectedVideo, selectedVideoOpenUrl } = useMemo(
    () => selectLibraryVideos(selectedAccount, new URLSearchParams(query)), [selectedAccount, query]
  );
  const maxPrimaryMetric = Math.max(...sortedVideos.map((video) => getPrimaryMetric(video).sortValue), 1);
  const completedCount = sortedVideos.filter((video) => video.transcriptStatus === "completed").length;
  const failedCount = sortedVideos.filter((video) => video.transcriptStatus === "failed").length;
  const pendingCount = sortedVideos.length - completedCount;

  const replaceParams = updateLibraryUrl;

  useEffect(() => {
    if (!selectedAccount || searchParams.get("account") !== selectedAccount.id) return;
    const effectiveId = selectedVideo?.id || "";
    if (requestedVideoId === effectiveId) return;
    replaceParams({ video: effectiveId || null });
  }, [replaceParams, requestedVideoId, searchParams, selectedAccount, selectedVideo?.id]);

  useEffect(() => {
    const visibleIds = new Set(sortedVideos.map((video) => video.id));
    setSelectedVideoIds((current) => current.filter((videoId) => visibleIds.has(videoId)));
    if (!selectedAccount || !sortedVideos.length) setVideoManageMode(false);
  }, [selectedAccount, sortedVideos]);

  const selectVideo = useCallback((videoId: string, mobileView?: LibraryMobileView) => {
    if (videoManageMode) {
      setSelectedVideoIds((current) =>
        current.includes(videoId) ? current.filter((id) => id !== videoId) : [...current, videoId]
      );
      return;
    }
    updateLibraryUrl({
      video: videoId || null,
      ...(mobileView ? { mv: mobileView === "accounts" ? null : mobileView } : {})
    }, "push");
  }, [videoManageMode]);

  const changeSortMode = useCallback((mode: VideoSortMode) => {
    const resolvedMode = resolveEffectiveVideoSortMode(mode, selectedAccount?.platform);
    const nextDirection = resolvedMode === effectiveSortMode
      ? sortDirection === "asc" ? "desc" : "asc"
      : defaultSortDirection(resolvedMode);
    replaceParams({
      sort: resolvedMode === "hot" ? null : resolvedMode,
      dir: nextDirection === defaultSortDirection(resolvedMode) ? null : nextDirection
    });
  }, [effectiveSortMode, replaceParams, selectedAccount?.platform, sortDirection]);

  const toggleVideoManage = useCallback(() => {
    setVideoManageMode((current) => !current);
    setSelectedVideoIds([]);
  }, []);

  return {
    completedCount,
    effectiveSortMode,
    failedCount,
    maxPrimaryMetric,
    pendingCount,
    requestedVideoId,
    selectedVideo,
    selectedVideoIds,
    selectedVideoOpenUrl,
    sortDirection,
    sortedVideos,
    videoFilter,
    videoManageMode,
    videoStatusFilter,
    changeSortMode,
    selectVideo,
    setSelectedVideoIds,
    setVideoFilter: (value: string) => replaceParams({ vq: value || null }),
    setVideoManageMode,
    setVideoStatusFilter: (value: VideoStatusFilter) => replaceParams({ videoStatus: value === "all" ? null : value }),
    toggleVideoManage
  };
}
