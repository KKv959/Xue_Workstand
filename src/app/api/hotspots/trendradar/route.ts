import { apiJson } from "@/lib/api-route";
import { getTrendRadarFeed } from "@/lib/trendradar";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return apiJson(() => getTrendRadarFeed(request.signal), { fallbackMessage: "读取 TrendRadar 候选结果失败" }); }
