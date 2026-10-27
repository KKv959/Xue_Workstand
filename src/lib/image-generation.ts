import { resolveAiPolicy } from "./ai-policy-runtime";
import { callImageApi, imageConfig } from "./image-runtime";
import { imageGenerationInputSchema, type ImageGenerationInput, type ImageGenerationRecord } from "./image-generation-types";
import { getImageFile, getImageRecord, saveImageFile, saveImageRecord } from "./storage/images";
import { resolveImageMentions } from "./image-mentions";
import { STORAGE_SCHEMA_VERSION } from "./storage/schemas";
import { runPiImage } from "./pi-runtime";

export async function generateImages(id: string, input: ImageGenerationInput, options: {
  signal?: AbortSignal;
  onProgress: (message: string, progress: number, saved: boolean) => Promise<void>;
}) {
  const params = imageGenerationInputSchema.parse(input);
  const policy = await resolveAiPolicy("image_generate");
  const subscription = policy.source === "subscription";
  const baseConfig = imageConfig(subscription ? "default" : params.profileId);
  const config = { ...baseConfig, model: policy.model || baseConfig.model };
  const prompt = resolveImageMentions(params.prompt, params.referenceIds);
  if (params.parentRecordId) {
    const parent = await getImageRecord(params.parentRecordId);
    if (!parent || (parent.canvasId || parent.id) !== params.canvasId) throw new Error("来源记录与当前画布不一致，请重新选择来源图片。");
    if (params.parentImageId && (!parent.images.some((image) => image.id === params.parentImageId) || !params.referenceIds.includes(params.parentImageId))) throw new Error("来源图片不存在或未加入参考图，请重新选择。");
  } else if (params.parentImageId) throw new Error("缺少来源记录，请重新选择来源图片。");
  const now = new Date().toISOString();
  const record: ImageGenerationRecord = { ...params, schemaVersion: STORAGE_SCHEMA_VERSION, id, model: subscription ? "ChatGPT 订阅生图" : config.model, source: subscription ? "subscription" : "relay", images: [], createdAt: now, updatedAt: now };
  options.signal?.throwIfAborted();
  await saveImageRecord(record);
  await options.onProgress("正在准备参考图", 5, true);
  const referenceFiles = [];
  for (const referenceId of params.referenceIds) {
    options.signal?.throwIfAborted();
    const { image, bytes, contentType } = await getImageFile(referenceId);
    if (bytes.length > 10 * 1024 * 1024) throw new Error(`参考图「${image.name}」超过 10MB，请缩小后重新添加。`);
    referenceFiles.push({ name: `${image.id}.${image.format}`, bytes, contentType });
  }
  for (let index = 0; index < params.count; index++) {
    options.signal?.throwIfAborted();
    await options.onProgress(`正在生成第 ${index + 1} / ${params.count} 张图片`, 10 + Math.floor(index / params.count * 85), false);
    const bytes = subscription
      ? await runPiImage({ prompt, size: params.size, quality: params.quality, images: referenceFiles.map(file => `data:${file.contentType};base64,${file.bytes.toString("base64")}`) }, options.signal)
      : await callImageApi({ config: { ...config, size: params.size, quality: params.quality }, prompt, referenceFiles, signal: options.signal });
    options.signal?.throwIfAborted();
    const image = await saveImageFile(bytes, `生成图片 ${index + 1}`);
    record.images.push(image);
    record.updatedAt = new Date().toISOString();
    await saveImageRecord(record);
    await options.onProgress(`已保存 ${record.images.length} / ${params.count} 张图片`, 10 + Math.floor((index + 1) / params.count * 85), true);
  }
  return record;
}
