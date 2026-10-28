import { formatPlatform } from "@/components/Formatters";
import { getVideoOpenUrl, type VideoSortMode } from "@/app/library/_components/library-view-utils";
import type { AccountListItem, AccountDetail, VideoListItem } from "./types";

export type VideoStatusFilter = "all" | "pending" | "completed" | "failed";
export type SortDirection = "asc" | "desc";

export function filterLibraryAccounts(accounts: AccountListItem[], filter: string) {
  const keyword = filter.trim().toLowerCase();
  return accounts.filter(account => !keyword || `${account.name} ${formatPlatform(account.platform)} ${account.uid}`.toLowerCase().includes(keyword))
    .sort((a, b) => +new Date(b.lastCollectedAt || b.updatedAt) - +new Date(a.lastCollectedAt || a.updatedAt));
}

export function selectLibraryVideos(account: AccountDetail | null, params: URLSearchParams) {
  const videoFilter = params.get("vq") || "";
  const videoStatusFilter = parseVideoStatusFilter(params.get("videoStatus"));
  const requestedSortMode = parseVideoSortMode(params.get("sort"));
  const sortDirection = parseSortDirection(params.get("dir"), requestedSortMode);
  const effectiveSortMode = resolveEffectiveVideoSortMode(requestedSortMode, account?.platform);
  const requestedVideoId = params.get("video") || "";
  const keyword = videoFilter.trim().toLowerCase();
  const sortedVideos = (account?.videos || []).filter(video => {
    if (keyword && !video.title.toLowerCase().includes(keyword)) return false;
    if (videoStatusFilter === "completed") return video.transcriptStatus === "completed";
    if (videoStatusFilter === "failed") return video.transcriptStatus === "failed";
    if (videoStatusFilter === "pending") return video.transcriptStatus !== "completed";
    return true;
  }).sort(getVideoSorter(effectiveSortMode, sortDirection));
  const selectedVideo = sortedVideos.find(video => video.id === requestedVideoId) || sortedVideos[0] || null;
  return { videoFilter, videoStatusFilter, sortDirection, effectiveSortMode, requestedVideoId, sortedVideos, selectedVideo, selectedVideoOpenUrl: getVideoOpenUrl(selectedVideo) };
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

export function defaultSortDirection(mode: VideoSortMode): SortDirection {
  return mode === "title" ? "asc" : "desc";
}

export function resolveEffectiveVideoSortMode(sortMode: VideoSortMode, platform?: AccountDetail["platform"]): VideoSortMode {
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
