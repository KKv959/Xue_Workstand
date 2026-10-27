import { apiJson, isLocalSameOriginRequest, parseJsonBody } from "@/lib/api-route";
import { getAiSettingsView } from "@/lib/ai-policy-runtime";
import { aiSettingsSchema } from "@/lib/storage/schemas";
import { saveAiSettings, validateAiSettings } from "@/lib/storage/ai-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return apiJson(getAiSettingsView, { fallbackMessage: "读取 AI 模型配置失败" });
}

export function PUT(request: Request) {
  if (!isLocalSameOriginRequest(request)) {
    return Response.json({ error: "为保护模型配置，请在本机工作站页面保存高级设置" }, { status: 403 });
  }
  return apiJson(async () => {
    const body = await parseJsonBody(request, aiSettingsSchema);
    let value;
    try { value = validateAiSettings(body); }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error("AI 配置无效"), { status: 400 }); }
    await saveAiSettings(value);
    return getAiSettingsView();
  }, { fallbackMessage: "保存 AI 模型配置失败" });
}
