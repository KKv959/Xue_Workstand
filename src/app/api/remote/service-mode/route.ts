import { z } from "zod";
import { apiJson, formatApiError, parseJsonBody } from "@/lib/api-route";
import { getServiceModeStatus, switchServiceMode } from "@/lib/service-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiJson(() => getServiceModeStatus(request), { fallbackMessage: "读取服务模式失败" });
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const { mode } = await parseJsonBody(request, z.object({ mode: z.enum(["development", "production"]) }));
    return switchServiceMode(request, mode);
  }, {
    fallbackMessage: "切换服务模式失败",
    formatError: (error, fallback) => `${fallback}：${formatApiError(error, fallback)}`
  });
}
