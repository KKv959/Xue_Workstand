"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatPlatform } from "@/components/Formatters";
import type { AccountDetail, AccountListItem, VideoListItem } from "@/lib/types";
import { getPrimaryMetric, getVideoOpenUrl, type VideoSortMode } from "../_components/library-view-utils";

export type VideoStatusFilter = "all" | "pending" | "completed" | "failed";
export type SortDirection = "asc" | "desc";
type LibraryMobileView = "accounts" | "videos" | "detail";

export function useLibraryAccountSelection(accounts: AccountListItem[]) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [accountManageMode, setAccountManageMode] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);

  const accountFilter = searchParams.get("q") || "";
  const requestedAccountId = searchParams.get("account") || "";

  const filteredAccounts = useMemo(() => {
    const keyword = accountFilter.trim().toLowerCase();
    return accounts
      .filter((account) => {
        if (!keyword) return true;
        const haystack = `${account.name} ${formatPlatform(account.platform)} ${account.uid}`.toLowerCase();
        return haystack.includes(keyword);
      })
      .sort((a, b) => +new Date(b.lastCollectedAt || b.updatedAt) - +new Date(a.lastCollectedAt || a.updatedAt));
  }, [accountFilter, accounts]);

  const selectedAccountMeta = useMemo(
    () => filteredAccounts.find((account) => account.id === requestedAccountId) || filteredAccounts[0] || null,
    [filteredAccounts, requestedAccountId]
  );

  const replaceParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

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
    replaceParams({
      account: accountId || null,
      video: null,
      ...(mobileView ? { mv: mobileView === "accounts" ? null : mobileView } : {})
    });
  }, [replaceParams]);

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [videoManageMode, setVideoManageMode] = useState(false);
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);

  const videoFilter = searchParams.get("vq") || "";
  const videoStatusFilter = parseVideoStatusFilter(searchParams.get("videoStatus"));
  const requestedSortMode = parseVideoSortMode(searchParams.get("sort"));
  const sortDirection = parseSortDirection(searchParams.get("dir"), requestedSortMode);
  const effectiveSortMode = resolveEffectiveVideoSortMode(requestedSortMode, selectedAccount?.platform);
  const requestedVideoId = searchParams.get("video") || "";

  const filteredVideos = useMemo(() => {
    const keyword = videoFilter.trim().toLowerCase();
    return (selectedAccount?.videos || []).filter((video) => {
      if (keyword && !video.title.toLowerCase().includes(keyword)) return false;
      if (videoStatusFilter === "completed") return video.transcriptStatus === "completed";
      if (videoStatusFilter === "failed") return video.transcriptStatus === "failed";
      if (videoStatusFilter === "pending") return video.transcriptStatus !== "completed";
      return true;
    });
  }, [selectedAccount?.videos, videoFilter, videoStatusFilter]);

  const sortedVideos = useMemo(
    () => [...filteredVideos].sort(getVideoSorter(effectiveSortMode, sortDirection)),
    [effectiveSortMode, filteredVideos, sortDirection]
  );
  const selectedVideo = sortedVideos.find((video) => video.id === requestedVideoId) || sortedVideos[0] || null;
  const selectedVideoOpenUrl = getVideoOpenUrl(selectedVideo);
  const maxPrimaryMetric = Math.max(...sortedVideos.map((video) => getPrimaryMetric(video).sortValue), 1);
  const completedCount = sortedVideos.filter((video) => video.transcriptStatus === "completed").length;
  const failedCount = sortedVideos.filter((video) => video.transcriptStatus === "failed").length;
  const pendingCount = sortedVideos.length - completedCount;

  const replaceParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

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
    replaceParams({
      video: videoId || null,
      ...(mobileView ? { mv: mobileView === "accounts" ? null : mobileView } : {})
    });
  }, [replaceParams, videoManageMode]);

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

const videoTitleCollator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
const videoSortModes: VideoSortMode[] = ["hot", "title", "views", "likes", "comments", "favorites", "latest"];

function parseVideoStatusFilter(value: string | null): VideoStatusFilter {
  return value === "pending" || value === "completed" || value === "failed" ? value : "all";
}

function parseVideoSortMode(value: string | null): VideoSortMode {
  return videoSortModes.includes(value as VideoSortMode) ? (value as VideoSortMode) : "hot";
}

function parseSortDirection(value: string | null, mode: VideoSortMode): SortDirection {
  return value === "asc" || value === "desc" ? value : defaultSortDirection(mode);
}

function defaultSortDirection(mode: VideoSortMode): SortDirection {
  return mode === "title" ? "asc" : "desc";
}

function resolveEffectiveVideoSortMode(sortMode: VideoSortMode, platform?: AccountDetail["platform"]): VideoSortMode {
  if (platform === "douyin") return sortMode === "views" ? "hot" : sortMode;
  return sortMode === "hot" ? "views" : sortMode;
}

function getVideoSorter(sortMode: VideoSortMode, direction: SortDirection) {
  const sorters: Record<VideoSortMode, (a: VideoListItem, b: VideoListItem) => number> = {
    hot: (a, b) => b.hotScore - a.hotScore,
    title: (a, b) => videoTitleCollator.compare(a.title, b.title),
    views: (a, b) => b.stats.views - a.stats.views,
    likes: (a, b) => b.stats.likes - a.stats.likes,
    comments: (a, b) => b.stats.comments - a.stats.comments,
    favorites: (a, b) => b.stats.favorites - a.stats.favorites,
    latest: (a, b) => +new Date(b.publishedAt || 0) - +new Date(a.publishedAt || 0)
  };
  const base = sorters[sortMode];
  const defaultDirection = defaultSortDirection(sortMode);
  return direction === defaultDirection ? base : (a: VideoListItem, b: VideoListItem) => -base(a, b);
}
