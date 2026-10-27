import type { ImageGenerationConfig, ImageGenerationInput } from "./image-generation-types";
import { imageModelLabel, imageProfileForModel, imageRatioForSize, imageSizeForProfile } from "./image-profile-options";
export function imageModelBatch(input: ImageGenerationInput, models: string[], profiles: ImageGenerationConfig["profiles"]) {
  if (models.length === 0) return [input];
  const selected = profiles.find((profile) => profile.id === (input.profileId || "default"));
  return [...new Set(models)].map((model) => {
    const profile = selected?.model === model && selected.configured ? selected : imageProfileForModel(profiles, model, selected?.resolution);
    if (!profile?.configured) throw new Error(`${imageModelLabel(model)} 未配置，请先取消勾选或配置服务。`);
    return { ...input, profileId: profile.id, size: profile.id === input.profileId ? input.size : imageSizeForProfile(profile, imageRatioForSize(input.size)) };
  });
}
