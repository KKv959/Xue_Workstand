import { z } from "zod";

export const imageSizes = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const imageQualities = ["auto", "high", "medium", "low"] as const;
export const imageCanvasIdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/, "画布 ID 不合法。");
export const imageGenerationInputSchema = z.object({
  prompt: z.string().trim().min(1, "请填写提示词。").max(12000, "提示词最多 12000 字。"),
  size: z.string().refine((value) => value === "auto" || (/^\d+x\d+$/.test(value) && value.split("x").every((n) => Number(n) >= 256 && Number(n) <= 4096)), "宽高必须为 256–4096 的整数，或选择自动尺寸。"),
  profileId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  canvasId: imageCanvasIdSchema.optional(),
  parentRecordId: imageCanvasIdSchema.optional(),
  parentImageId: z.string().uuid("来源图片 ID 不合法。").optional(),
  quality: z.enum(imageQualities),
  count: z.number().int().min(1).max(4, "每次最多生成 4 张图片。"),
  referenceIds: z.array(z.string().uuid("参考图 ID 不合法。")).max(6, "最多使用 6 张参考图。")
});
export type ImageGenerationInput = z.infer<typeof imageGenerationInputSchema>;
export type ImageFile = { id: string; name: string; format: "png" | "jpeg" | "webp"; createdAt: string };
export type ImageGenerationRecord = ImageGenerationInput & {
  schemaVersion: number;
  deletedAt?: string;
  id: string;
  model: string;
  source?: "subscription" | "relay";
  images: ImageFile[];
  createdAt: string;
  updatedAt: string;
};
export type ImageGenerationSummary = Pick<ImageGenerationRecord, "id" | "model" | "size" | "count" | "createdAt" | "updatedAt" | "canvasId" | "parentRecordId" | "parentImageId"> & {
  title: string;
  imageCount: number;
  thumbnail?: ImageFile;
  referenceIds?: string[];
};
export type ImageGenerationConfig = { configured: boolean; model: string; defaultProfileId: string; profiles: { id: string; label: string; model: string; resolution?: "1080p" | "2k" | "4k"; configured: boolean }[] };
export type ImageGenerationList = { records: ImageGenerationSummary[]; total: number };
export function imageFileUrl(id: string, download = false) {
  return `/api/images/files/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

export type ImageRecordDeleteResult = { deleted: string[]; trashOperationId?: string };
