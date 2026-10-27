import type { Platform, VideoStats } from "./types";

const LIKE_HEAT_WEIGHT = 22;
const COMMENT_HEAT_WEIGHT = 80;
const FAVORITE_HEAT_WEIGHT = 70;
const SHARE_HEAT_WEIGHT = 90;
const MAX_RECENCY_BOOST = 0.25;
const VELOCITY_WINDOW_HOURS = 36;
const VELOCITY_AGE_FLOOR_HOURS = 0.5;
const VELOCITY_BONUS_MULTIPLIER = 14;
const VELOCITY_FULL_CONFIDENCE_HEAT = LIKE_HEAT_WEIGHT * 1000;
const BILIBILI_VIEW_BASELINE = 25_000;
const BILIBILI_VIEW_TO_ENGAGEMENT_CAP = 1.5;

export const HOTLIST_SCORE_VERSION = 2;

type HotlistScoreVideo = {
  platform: Platform;
  stats: VideoStats;
};

export function calculateHotlistInteractionHeat(stats: VideoStats) {
  return (
    stats.likes * LIKE_HEAT_WEIGHT +
    stats.comments * COMMENT_HEAT_WEIGHT +
    stats.favorites * FAVORITE_HEAT_WEIGHT +
    (stats.shares ?? 0) * SHARE_HEAT_WEIGHT
  );
}

export function calculateHotlistBaseScore(video: HotlistScoreVideo) {
  const interactionHeat = calculateHotlistInteractionHeat(video.stats);
  const viewContribution = normalizeViewContribution(video.platform, video.stats.views, interactionHeat);
  return Math.round(interactionHeat + viewContribution);
}

export function calculateHotlistRankScore(
  video: HotlistScoreVideo,
  ageHours: number | undefined,
  windowHours: number
) {
  const base = calculateHotlistBaseScore(video);
  const recencyMultiplier =
    ageHours === undefined ? 1 : 1 + Math.max(0, windowHours - ageHours) / windowHours * MAX_RECENCY_BOOST;
  const velocity = calculateHotlistVelocity(calculateHotlistInteractionHeat(video.stats), ageHours);
  return Math.round(base * recencyMultiplier + velocity.bonus);
}

export function calculateHotlistVelocity(interactionHeat: number, ageHours?: number) {
  if (ageHours === undefined || interactionHeat <= 0) {
    return {
      heatPerHour: 0,
      bonus: 0
    };
  }

  const effectiveAgeHours = Math.max(ageHours, VELOCITY_AGE_FLOOR_HOURS);
  const earlyFactor = Math.max(0, (VELOCITY_WINDOW_HOURS - effectiveAgeHours) / VELOCITY_WINDOW_HOURS);
  const heatPerHour = interactionHeat / effectiveAgeHours;
  const confidence = Math.min(1, interactionHeat / VELOCITY_FULL_CONFIDENCE_HEAT);

  return {
    heatPerHour,
    bonus: heatPerHour * VELOCITY_BONUS_MULTIPLIER * earlyFactor * confidence
  };
}

function normalizeViewContribution(platform: Platform, views: number, interactionHeat: number) {
  const safeViews = Number.isFinite(views) ? Math.max(0, views) : 0;
  if (!safeViews) return 0;

  // Douyin usually omits views while Bilibili always returns them. Cap the
  // Bilibili-only dimension so the cross-platform list remains comparable.
  if (platform === "bilibili") {
    return Math.min(safeViews, interactionHeat * BILIBILI_VIEW_TO_ENGAGEMENT_CAP + BILIBILI_VIEW_BASELINE);
  }

  return Math.min(safeViews, Math.max(interactionHeat, BILIBILI_VIEW_BASELINE));
}
