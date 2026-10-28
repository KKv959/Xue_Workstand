import { formatDateWithYear } from "@/components/Formatters";
import type { FeedbackTone } from "@/components/FeedbackProvider";
import { buildDouyinVideoUrl, extractDouyinAwemeId, isLikelyDirectMediaUrl } from "@/lib/platform-links";
import type { Video, VideoListItem } from "@/lib/types";

export type VideoSortMode = "hot" | "title" | "views" | "likes" | "comments" | "favorites" | "latest";
export type LibraryMessageSetter = (message: string, tone?: FeedbackTone) => void;

export function canReadTranscript(video: Pick<Video, "transcriptStatus" | "transcriptPath"> | null) {
  return Boolean(video?.transcriptPath) || video?.transcriptStatus === "completed";
}

export function getVideoOpenUrl(video: VideoListItem | null) {
  if (!video?.url) return "";
  if (video.platform !== "douyin") return video.url;
  if (!isLikelyDirectMediaUrl(video.url)) return video.url;

  return buildDouyinVideoUrl(extractDouyinAwemeId(video.id)) || video.url;
}

export function makePreview(text: string, markdown = false) {
  const readable = markdown ? text
    .replace(/^(?:#{1,6}\s+)?风格卡[^\n]*(?:\n|$)/, "")
    .replace(/^# [^\n]*(?:\n|$)/, "")
    .replace(/\[\[\d+\]\]/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") : text;
  const preview = readable.replace(/\r\n/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return preview.length > 480 ? `${preview.slice(0, 480)}…` : preview;
}

export function getVideoMetaText(video: Pick<Video, "publishedAt">) {
  return formatDateWithYear(video.publishedAt);
}

export function isVideoMetricMissing(
  video: Pick<Video, "platform" | "stats" | "statsHydration">,
  field: "comments" | "favorites"
) {
  if (video.platform !== "douyin") return false;
  if (video.statsHydration?.status === "complete") return false;
  if (video.statsHydration?.missingFields) return video.statsHydration.missingFields.includes(field);
  return video.stats[field] === 0;
}

export function getPrimaryMetric(video: Pick<Video, "platform" | "hotScore" | "stats">) {
  if (video.platform === "douyin") {
    return {
      sortValue: Math.round(video.hotScore)
    };
  }

  return {
    sortValue: video.stats.views
  };
}
