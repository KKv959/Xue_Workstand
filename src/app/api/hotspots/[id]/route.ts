import { apiJson } from "@/lib/api-route";
import { getHotspotDetail } from "@/lib/hotspots";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return apiJson(async () => getHotspotDetail((await context.params).id), { fallbackMessage: "读取选题详情失败" });
}
