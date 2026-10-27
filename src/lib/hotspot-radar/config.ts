import { z } from "zod";

const settingsSchema = z.object({
  sources: z.array(z.enum(["hotlist", "rss"])).min(1),
  maxAgeHours: z.coerce.number().int().min(6).max(168),
  candidateLimit: z.coerce.number().int().min(12).max(120),
  perSourceLimit: z.coerce.number().int().min(3).max(60),
  fineLimit: z.coerce.number().int().min(6).max(48),
  interests: z.string().min(1).max(2000),
  exclude: z.array(z.string().min(1).max(100)).max(100),
  report: z.boolean()
});
export type RadarPipelineConfig = z.infer<typeof settingsSchema>;
export function getRadarPipelineConfig(): RadarPipelineConfig {
  const parsed = settingsSchema.safeParse({
    sources: (process.env.HOTSPOT_RADAR_INPUTS || "hotlist,rss").split(",").map(value => value.trim()).filter(value => value !== "video"),
    maxAgeHours: process.env.HOTSPOT_RADAR_MAX_AGE_HOURS || 72,
    candidateLimit: process.env.HOTSPOT_RADAR_COARSE_LIMIT || 80,
    perSourceLimit: process.env.HOTSPOT_RADAR_PER_SOURCE_LIMIT || 20,
    fineLimit: process.env.HOTSPOT_RADAR_FINE_LIMIT || 24,
    interests: process.env.HOTSPOT_RADAR_INTERESTS || "游戏短视频：人物故事、玩家冲突、反差和具体评论空间",
    exclude: (process.env.HOTSPOT_RADAR_EXCLUDE || "").split(/[,，\n]/).map(value => value.trim()).filter(Boolean),
    report: process.env.HOTSPOT_RADAR_REPORT === "1"
  });
  if (!parsed.success) throw new Error(`热点分析配置无效：${parsed.error.issues.map(issue => issue.path.join(".") + " " + issue.message).join("；")}`);
  return parsed.data;
}
