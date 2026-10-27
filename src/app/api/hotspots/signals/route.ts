import { z } from "zod";
import { apiJson } from "@/lib/api-route";
import { getRadarSignals } from "@/lib/hotspots";
export const runtime = "nodejs";
const querySchema = z.object({ page: z.coerce.number().int().min(1).max(10000).optional(), search: z.string().max(200).optional(), source: z.string().max(100).optional(), id: z.string().max(300).optional() });
export async function GET(request: Request) {
  return apiJson(() => getRadarSignals(querySchema.parse(Object.fromEntries(new URL(request.url).searchParams))), { fallbackMessage: "读取采集资讯失败" });
}
