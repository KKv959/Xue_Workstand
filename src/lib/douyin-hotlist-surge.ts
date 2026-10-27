import type { Platform, VideoHotlistSurgeState, VideoHotlistTrend } from "./types";

const SURGE_RETENTION_HOURS = 6;
const SURGE_INTERVAL_FLOOR_HOURS = 0.25;
const SURGE_SHORT_INTERVAL_HOURS = 1;
const SURGE_MEDIUM_INTERVAL_HOURS = 6;
const SURGE_MIN_VERY_SHORT_HEAT_DELTA = 6_000;
const SURGE_MIN_SHORT_HEAT_DELTA = 8_000;
const SURGE_MIN_HEAT_DELTA = 12_000;
const SURGE_SHORT_MIN_HEAT_PER_HOUR = 18_000;
const SURGE_MEDIUM_MIN_HEAT_PER_HOUR = 10_000;
const SURGE_LONG_MIN_HEAT_PER_HOUR = 6_000;
const BILIBILI_SURGE_THRESHOLD_MULTIPLIER = 1.5;
const BILIBILI_MATURE_VIDEO_HOURS = 6;
const BILIBILI_OLD_VIDEO_HOURS = 24;
const BILIBILI_MATURE_MIN_HEAT_SCORE = 250_000;
const BILIBILI_MATURE_MIN_VIEWS = 80_000;
const BILIBILI_MATURE_MIN_LIKES = 3_000;
const BILIBILI_MATURE_MIN_COMMENTS = 300;
const BILIBILI_MATURE_MIN_FAVORITES = 500;
const BILIBILI_OLD_MIN_HEAT_SCORE = 800_000;
const BILIBILI_OLD_MIN_VIEWS = 300_000;
const BILIBILI_OLD_MIN_LIKES = 10_000;
const BILIBILI_OLD_MIN_COMMENTS = 800;
const BILIBILI_OLD_MIN_FAVORITES = 1_200;
const DOUYIN_MATURE_VIDEO_HOURS = 6;
const DOUYIN_OLD_VIDEO_HOURS = 24;
const DOUYIN_MATURE_MIN_HEAT_SCORE = 200_000;
const DOUYIN_MATURE_MIN_LIKES = 3_000;
const DOUYIN_MATURE_MIN_COMMENTS = 1_200;
const DOUYIN_MATURE_MIN_FAVORITES = 800;
const DOUYIN_MATURE_MIN_SHARES = 3_000;
const DOUYIN_OLD_MIN_HEAT_SCORE = 400_000;
const DOUYIN_OLD_MIN_LIKES = 5_000;
const DOUYIN_OLD_MIN_COMMENTS = 2_000;
const DOUYIN_OLD_MIN_FAVORITES = 1_500;
const DOUYIN_OLD_MIN_SHARES = 5_000;

export type HotlistSurgeDecision = {
  heatDelta: number;
  heatPerHour: number;
  intervalHours: number;
  minHeatPerHour: number;
};

export type HotlistSurgeEligibilityInput = {
  ageHours?: number;
  hotScore?: number;
  platform?: Platform;
  stats?: {
    comments: number;
    favorites: number;
    likes: number;
    shares?: number;
    views?: number;
  };
};

export function getHotlistSurgeDecision(trend?: VideoHotlistTrend, platform?: Platform): HotlistSurgeDecision | null {
  if (!trend || trend.heatDelta <= 0 || trend.intervalHours <= 0) return null;

  const intervalHours = Math.max(SURGE_INTERVAL_FLOOR_HOURS, trend.intervalHours);
  const heatPerHour = trend.heatDelta / intervalHours;
  const minHeatPerHour = getSurgeMinHeatPerHour(intervalHours, platform);
  const minHeatDelta = getSurgeMinHeatDelta(intervalHours, minHeatPerHour, platform);
  if (trend.heatDelta < minHeatDelta || heatPerHour < minHeatPerHour) return null;

  return {
    heatDelta: Math.round(trend.heatDelta),
    heatPerHour: Math.round(heatPerHour),
    intervalHours: roundTo(trend.intervalHours, 2),
    minHeatPerHour
  };
}

export function isHotlistSurgeEligible(input: HotlistSurgeEligibilityInput) {
  if (input.platform === "bilibili") {
    return hasHotlistSurgeBaseline(input, {
      matureHours: BILIBILI_MATURE_VIDEO_HOURS,
      oldHours: BILIBILI_OLD_VIDEO_HOURS,
      mature: {
        comments: BILIBILI_MATURE_MIN_COMMENTS,
        favorites: BILIBILI_MATURE_MIN_FAVORITES,
        heatScore: BILIBILI_MATURE_MIN_HEAT_SCORE,
        likes: BILIBILI_MATURE_MIN_LIKES,
        views: BILIBILI_MATURE_MIN_VIEWS
      },
      old: {
        comments: BILIBILI_OLD_MIN_COMMENTS,
        favorites: BILIBILI_OLD_MIN_FAVORITES,
        heatScore: BILIBILI_OLD_MIN_HEAT_SCORE,
        likes: BILIBILI_OLD_MIN_LIKES,
        views: BILIBILI_OLD_MIN_VIEWS
      }
    });
  }

  if (input.platform !== "douyin") return true;
  return hasHotlistSurgeBaseline(input, {
    matureHours: DOUYIN_MATURE_VIDEO_HOURS,
    oldHours: DOUYIN_OLD_VIDEO_HOURS,
    mature: {
      comments: DOUYIN_MATURE_MIN_COMMENTS,
      favorites: DOUYIN_MATURE_MIN_FAVORITES,
      heatScore: DOUYIN_MATURE_MIN_HEAT_SCORE,
      likes: DOUYIN_MATURE_MIN_LIKES,
      shares: DOUYIN_MATURE_MIN_SHARES
    },
    old: {
      comments: DOUYIN_OLD_MIN_COMMENTS,
      favorites: DOUYIN_OLD_MIN_FAVORITES,
      heatScore: DOUYIN_OLD_MIN_HEAT_SCORE,
      likes: DOUYIN_OLD_MIN_LIKES,
      shares: DOUYIN_OLD_MIN_SHARES
    }
  });
}

export function shouldRetainHotlistSurgeState(platform?: Platform) {
  return platform !== "bilibili";
}

export function isHotlistSurgeStateAboveThreshold(
  state: Pick<VideoHotlistSurgeState, "heatDelta" | "heatPerHour" | "intervalHours"> | undefined,
  platform?: Platform
) {
  if (!state || state.heatDelta <= 0 || state.intervalHours <= 0) return false;

  const intervalHours = Math.max(SURGE_INTERVAL_FLOOR_HOURS, state.intervalHours);
  const minHeatPerHour = getSurgeMinHeatPerHour(intervalHours, platform);
  const minHeatDelta = getSurgeMinHeatDelta(intervalHours, minHeatPerHour, platform);
  return state.heatDelta >= minHeatDelta && state.heatPerHour >= minHeatPerHour;
}

type SurgeBaselineThresholds = {
  comments: number;
  favorites: number;
  heatScore: number;
  likes: number;
  shares?: number;
  views?: number;
};

function hasHotlistSurgeBaseline(
  input: HotlistSurgeEligibilityInput,
  config: {
    matureHours: number;
    oldHours: number;
    mature: SurgeBaselineThresholds;
    old: SurgeBaselineThresholds;
  }
) {
  if (input.ageHours === undefined || input.ageHours < config.matureHours) return true;

  const stats = input.stats;
  if (!stats) return true;

  const matureThresholds = input.ageHours >= config.oldHours ? config.old : config.mature;

  return (
    (input.hotScore ?? 0) >= matureThresholds.heatScore ||
    (stats.views ?? 0) >= (matureThresholds.views ?? Number.POSITIVE_INFINITY) ||
    stats.likes >= matureThresholds.likes ||
    stats.comments >= matureThresholds.comments ||
    stats.favorites >= matureThresholds.favorites ||
    (stats.shares ?? 0) >= (matureThresholds.shares ?? Number.POSITIVE_INFINITY)
  );
}

export function createHotlistSurgeState(
  decision: HotlistSurgeDecision,
  detectedAt: string
): VideoHotlistSurgeState {
  const detectedTime = new Date(detectedAt).getTime();
  const expiresAt = new Date(detectedTime + SURGE_RETENTION_HOURS * 3_600_000).toISOString();

  return {
    heatDelta: decision.heatDelta,
    heatPerHour: decision.heatPerHour,
    intervalHours: decision.intervalHours,
    detectedAt,
    expiresAt
  };
}

export function isHotlistSurgeActive(
  state: VideoHotlistSurgeState | undefined,
  now = Date.now()
): state is VideoHotlistSurgeState {
  if (!state?.expiresAt) return false;
  const expiresAt = new Date(state.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function formatHotlistSurgeReason(input: Pick<VideoHotlistSurgeState, "heatDelta" | "heatPerHour" | "intervalHours">) {
  return `${formatTrendInterval(input.intervalHours)}热度 +${formatCompactCount(input.heatDelta)}，约 ${formatCompactCount(input.heatPerHour)}/小时`;
}

export function getHotlistSurgeLabel(rank: number, heatPerHour: number, minHeatPerHour: number) {
  return rank <= 3 && heatPerHour >= minHeatPerHour * 1.5 ? "猛涨" : "飙升";
}

export function getSurgeMinHeatPerHour(intervalHours: number, platform?: Platform) {
  const multiplier = getSurgeThresholdMultiplier(platform);
  if (intervalHours <= SURGE_SHORT_INTERVAL_HOURS) return SURGE_SHORT_MIN_HEAT_PER_HOUR * multiplier;
  if (intervalHours <= SURGE_MEDIUM_INTERVAL_HOURS) return SURGE_MEDIUM_MIN_HEAT_PER_HOUR * multiplier;
  return SURGE_LONG_MIN_HEAT_PER_HOUR * multiplier;
}

function getSurgeMinHeatDelta(intervalHours: number, minHeatPerHour: number, platform?: Platform) {
  const multiplier = getSurgeThresholdMultiplier(platform);
  if (intervalHours <= SURGE_INTERVAL_FLOOR_HOURS) return SURGE_MIN_VERY_SHORT_HEAT_DELTA * multiplier;
  if (intervalHours <= SURGE_SHORT_INTERVAL_HOURS) return SURGE_MIN_SHORT_HEAT_DELTA * multiplier;
  return Math.max(SURGE_MIN_HEAT_DELTA * multiplier, minHeatPerHour * Math.min(intervalHours, 3));
}

function getSurgeThresholdMultiplier(platform?: Platform) {
  return platform === "bilibili" ? BILIBILI_SURGE_THRESHOLD_MULTIPLIER : 1;
}

function formatCompactCount(value: number) {
  if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function formatTrendInterval(intervalHours: number) {
  if (intervalHours < 1) return `${Math.max(1, Math.round(intervalHours * 60))}分钟内`;
  if (intervalHours < 24) return `${Math.round(intervalHours * 10) / 10}小时内`;
  return `${Math.round((intervalHours / 24) * 10) / 10}天内`;
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
