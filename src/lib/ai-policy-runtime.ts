import { AI_POLICIES, type AiPolicyId, type AiPolicyValue, type AiSettingsView } from "./ai-policy-catalog";
import { readAiSettings } from "./storage/ai-settings";
import { getChatConfig, getConfiguredChatConfigs, getConfiguredWebResearchConfigs, getWebResearchConfig, type ChatRuntimeConfig } from "./model-runtime";
import { imageConfig, publicImageProfiles, defaultImageProfileId } from "./image-runtime";

export async function resolveAiPolicy(id: AiPolicyId): Promise<AiPolicyValue> {
  const settings = await readAiSettings();
  const definition = AI_POLICIES.find((entry) => entry.id === id)!;
  return settings.overrides[id] || { model: definition.model, effort: definition.effort };
}
export async function applyAiPolicy(configs: ChatRuntimeConfig[], id?: AiPolicyId) {
  if (!id) return configs;
  const policy = await resolveAiPolicy(id);
  return configs.map((config) => ({
    ...config,
    model: policy.model || config.model,
    ...(policy.effort === "default" ? {} : { reasoningEffort: policy.effort, chatCompletionReasoningEffort: policy.effort })
  }));
}
export async function aiPolicySignature(ids: AiPolicyId[]) {
  const settings = await readAiSettings();
  const legacy = ids.map((id) => settings.overrides[id] || AI_POLICIES.find((entry) => entry.id === id));
  return JSON.stringify(legacy);
}
export async function getAiSettingsView(): Promise<AiSettingsView> {
  const settings = await readAiSettings();
  const chat = getConfiguredChatConfigs()[0] || getChatConfig();
  const web = getConfiguredWebResearchConfigs()[0] || getWebResearchConfig();
  const images = publicImageProfiles();
  const defaults = Object.fromEntries(AI_POLICIES.map((p) => [p.id, { model: p.model, effort: p.effort }])) as AiSettingsView["defaults"];
  const inheritedModels = {} as Record<AiPolicyId, string>;
  const inheritedEfforts = {} as AiSettingsView["inheritedEfforts"];
  const effective = Object.fromEntries(AI_POLICIES.map((p) => {
    const value = settings.overrides[p.id] || defaults[p.id];
    const config = p.id === "web_research" ? web : chat;
    const baseModel = p.id === "image_generate" ? imageConfig(defaultImageProfileId()).model : config.model;
    inheritedModels[p.id] = baseModel;
    const baseEffort = "kind" in p ? "none"
      : p.id === "vision" ? (config.wireApi === "chat_completions" ? "none" : "low") : config.reasoningEffort;
    inheritedEfforts[p.id] = baseEffort;
    const effort = value.effort === "default"
      ? baseEffort
      : value.effort;
    return [p.id, { model: value.model || baseModel, effort }];
  })) as AiSettingsView["effective"];
  return { ...settings, defaults, effective, inheritedModels, inheritedEfforts,
    models: [...new Set([chat.model, web.model, "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", ...images.map((p) => p.model)].filter(Boolean))],
    services: { chat: chat.model || "未配置", web: web.model, image: imageConfig(defaultImageProfileId()).model, asr: process.env.VOLCENGINE_ASR_RESOURCE_ID || "volc.seedasr.auc", transcriptCleaning: process.env.TRANSCRIPT_CLEAN_USE_MODEL === "true" }
  };
}
