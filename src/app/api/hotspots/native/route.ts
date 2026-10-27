import { apiJson, parseJsonBody } from "@/lib/api-route";
import { getTrendRadarNativeStatus } from "@/lib/trendradar-native";
import { trendRadarSettingsSchema } from "@/lib/trendradar-native-types";
import { createJob } from "@/lib/jobs";

export const runtime = "nodejs";
export async function GET() {
  return apiJson(getTrendRadarNativeStatus, { fallbackMessage: "读取 TrendRadar 报告失败" });
}
export async function POST(request: Request) {
  return apiJson(async () => {
    const settings = await parseJsonBody(request, trendRadarSettingsSchema);
    return createJob({ kind: "hotspot-refresh", title: "生成 TrendRadar 报告", href: "/hotspots?view=topics", input: { native: settings } });
  }, { fallbackMessage: "创建 TrendRadar 报告任务失败" });
}
