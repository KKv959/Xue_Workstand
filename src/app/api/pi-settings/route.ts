import { z } from "zod";
import { apiJson, isLocalSameOriginRequest, parseJsonBody } from "@/lib/api-route";
import { loadModelSettings, verifyPiSelection } from "@/lib/pi-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const selectionSchema = z.object({
  provider: z.enum(["openai", "openai-codex"]),
  model: z.string().min(1).max(200),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"])
}).strict();

export async function GET() {
  return apiJson(async () => {
    const { runtime, settings } = await loadModelSettings();
    const credentials = await runtime.listCredentials();
    return {
      provider: settings.getDefaultProvider() ?? "",
      model: settings.getDefaultModel() ?? "",
      thinking: settings.getDefaultThinkingLevel() ?? "medium",
      subscriptions: ["openai", "openai-codex"].map(provider => ({
        provider,
        connected: credentials.some(item => item.providerId === provider && item.type === "oauth"),
        models: runtime.getModels(provider).map(model => ({ id: model.id, name: model.name }))
      }))
    };
  }, { fallbackMessage: "读取 Pi 模型配置失败" });
}

export async function PUT(request: Request) {
  if (!isLocalSameOriginRequest(request)) {
    return Response.json({ error: "为保护订阅配置，请在本机工作站页面保存模型" }, { status: 403 });
  }
  return apiJson(async () => {
    const selection = await parseJsonBody(request, selectionSchema);
    const { runtime, settings } = await loadModelSettings();
    if (!runtime.getModel(selection.provider, selection.model)) throw Object.assign(new Error("所选模型不存在，请刷新列表后重试"), { status: 400 });
    const credentials = await runtime.listCredentials();
    if (!credentials.some(item => item.providerId === selection.provider && item.type === "oauth")) throw Object.assign(new Error("请先连接对应的模型订阅"), { status: 400 });
    // Codex's legacy catalog includes models an account may not actually be entitled to.
    // Validate that subscription path before persisting it; API-key/OpenAI entries keep the existing save contract.
    const verification = selection.provider === "openai-codex"
      ? await verifyPiSelection(runtime, selection, request.signal)
      : { verified: true as const };
    request.signal.throwIfAborted();
    settings.setDefaultModelAndProvider(selection.provider, selection.model);
    settings.setDefaultThinkingLevel(selection.thinking);
    await settings.flush();
    return { saved: true, verified: verification.verified, warning: "warning" in verification ? verification.warning : undefined };
  }, { fallbackMessage: "保存 Pi 模型配置失败" });
}
