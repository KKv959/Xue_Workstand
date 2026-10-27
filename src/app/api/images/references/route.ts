import { apiJson } from "@/lib/api-route";
import { assertJobKindAllowedForAppMode } from "@/lib/app-mode";
import { detectImageFormat, saveImageFile } from "@/lib/storage/images";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return apiJson(async () => {
    assertJobKindAllowedForAppMode("image-generation");
    const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
    if (Number(request.headers.get("content-length")) > 61 * 1024 * 1024) throw bad("参考图合计不能超过 60MB。");
    const form = await request.formData();
    const files = form.getAll("files");
    if (!files.length || files.length > 6) throw bad("请上传 1 至 6 张参考图。");
    const validated = [];
    for (const file of files) {
      if (!(file instanceof File) || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw bad("参考图仅支持 PNG、JPEG 或 WebP。");
      if (!file.size || file.size > 10 * 1024 * 1024) throw bad("每张参考图需小于 10MB，且不能为空。");
      const bytes = Buffer.from(await file.arrayBuffer());
      detectImageFormat(bytes);
      validated.push({ bytes, name: file.name });
    }
    const references = [];
    for (const file of validated) references.push(await saveImageFile(file.bytes, file.name));
    return { references };
  }, { fallbackMessage: "上传参考图失败，请重新选择图片" });
}
