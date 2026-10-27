import type { ImageGenerationConfig } from "./image-generation-types";
export type ImageProfile = ImageGenerationConfig["profiles"][number];
export const imageRatios = ["auto", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"] as const;
export const resolutionLabels = { "1080p": "1080P", "2k": "2K", "4k": "4K" };
export function imageModelLabel(model: string) { return model.replace(/^gpt-image-/i, "Image "); }
export function imageRatioForSize(size: string) {
  const [width, height] = size.split("x").map(Number);
  if (!Number.isFinite(width / height) || width <= 0 || height <= 0) return "auto";
  return imageRatios.find((ratio) => { const [x, y] = ratio.split(":").map(Number); return Math.abs(width / height - x / y) < 0.015; }) || `${width}:${height}`;
}
export function imageSizeForProfile(profile: ImageProfile | undefined, ratio: string) {
  if (ratio === "auto") return "auto";
  const edge = { "1080p": 1920, "2k": 2560, "4k": 3840 }[profile?.resolution || "1080p"];
  const [x, y] = ratio.split(":").map(Number);
  return x >= y ? `${edge}x${Math.round(edge * y / x)}` : `${Math.round(edge * x / y)}x${edge}`;
}
export function imageProfileForModel(profiles: ImageProfile[], model: string, resolution?: ImageProfile["resolution"]) {
  const candidates = profiles.filter((profile) => profile.model === model && profile.configured);
  return candidates.find((profile) => (profile.resolution || "1080p") === (resolution || "1080p")) || candidates.find((profile) => (profile.resolution || "1080p") === "1080p") || candidates[0];
}
