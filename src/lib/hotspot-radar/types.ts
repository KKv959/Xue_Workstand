export const radarGrades = ["吊爆了", "有点东西", "能做", "还行", "先看看"] as const;
export type RadarGrade = typeof radarGrades[number];
export type RadarRating = "吊爆了" | "还行" | "不行";
export type RadarAnalysis = {
  method: "ai-two-pass";
  pipeline?: "unified-events";
  eventCount?: number;
  candidateCount: number;
  coarseCount: number;
  analyzedCount: number;
  coverage: number;
  reusedItemCount?: number;
  fallback: boolean;
  fallbackReason?: string;
};
export type RadarDailyReport = { headline: string; overview: string; signals: string[]; communityMood: string; tomorrowWatch: string[] };
export type RadarFeedback = { schemaVersion: 1; ratings: Array<{ hotspotId: string; title: string; summary: string; rating: RadarRating; updatedAt: string }>; history: Array<{ hotspotId: string; rating: RadarRating; updatedAt: string }> };
