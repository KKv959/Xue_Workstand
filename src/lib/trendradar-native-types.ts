import { z } from "zod";

export const trendRadarSettingsSchema = z.object({
  mode: z.enum(["incremental", "current", "daily"]).default("daily"),
  filter: z.enum(["ai", "keyword"]).default("ai"),
  interests: z.string().trim().min(1, "请填写关注方向").max(2000).default("关注游戏行业、玩家争议、电竞人物、官方公告与游戏文化。优先具体事件与新进展，排除常规比分、泛科技产品促销。"),
});
export type TrendRadarSettings = z.infer<typeof trendRadarSettingsSchema>;
export type TrendRadarReport = {
  schemaVersion: 1;
  generatedAt: string;
  engineVersion: string;
  settings: TrendRadarSettings;
  analysis: { core_trends: string; sentiment_controversy: string; signals: string; rss_insights: string; outlook_strategy: string };
  counts: { hotlist: number; rss: number; matched: number; analyzed: number };
  warnings: string[];
  fallback: boolean;
  fallbackReason?: string;
};
export type TrendRadarNativeStatus = { report: TrendRadarReport | null; defaults: TrendRadarSettings };
