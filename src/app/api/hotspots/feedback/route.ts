import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { saveHotspotFeedback } from "@/lib/hotspots";
export const runtime = "nodejs";
const schema = z.object({ hotspotId: z.string().min(1).max(300), rating: z.enum(["吊爆了", "还行", "不行"]) }).strict();
export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    return saveHotspotFeedback(input.hotspotId, input.rating);
  }, { fallbackMessage: "保存选题评分失败" });
}
