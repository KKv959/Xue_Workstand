import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { createJob } from "@/lib/jobs";
import { getHotspotRadar } from "@/lib/hotspots";

export const runtime = "nodejs";

const postSchema = z.object({
  action: z.enum(["refresh", "retry-report", "continue-analysis"]).default("refresh")
});

export async function GET(request: Request) {
  return apiJson(async () => getHotspotRadar({ signal: request.signal }), {
    fallbackMessage: "读取热点雷达失败"
  });
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const body = await parseJsonBody(request, postSchema);
    return createJob({ kind: "hotspot-refresh", href: "/hotspots", input: { retryReport: body.action === "retry-report", continueAnalysis: body.action === "continue-analysis" } });
  }, {
    fallbackMessage: "刷新热点雷达失败"
  });
}
