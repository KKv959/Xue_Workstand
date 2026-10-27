import { apiJson } from "@/lib/api-route";
import { assertJobKindAllowedForAppMode } from "@/lib/app-mode";
import { defaultImageProfileId, imageConfig, publicImageProfiles } from "@/lib/image-runtime";
import { resolveAiSource } from "@/lib/ai-policy-runtime";
import { piImageConfigured } from "@/lib/pi-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return apiJson(async () => {
    assertJobKindAllowedForAppMode("image-generation");
    if (await resolveAiSource("image_generate") === "subscription") {
      const configured = await piImageConfigured();
      return { configured, model: "ChatGPT 订阅生图", defaultProfileId: "default", profiles: [{ id: "default", label: "ChatGPT 订阅生图", model: "ChatGPT 订阅生图", configured, resolution: "1080p" }] };
    }
    const config = imageConfig();
    return { configured: Boolean(config.apiKey), model: config.model, defaultProfileId: defaultImageProfileId(), profiles: publicImageProfiles() };
  }, { fallbackMessage: "读取图片模型配置失败" });
}
