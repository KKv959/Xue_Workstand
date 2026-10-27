import { apiError } from "@/lib/api-route";
import { assertJobKindAllowedForAppMode } from "@/lib/app-mode";
import { getImageFile } from "@/lib/storage/images";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertJobKindAllowedForAppMode("image-generation");
    const { id } = await context.params;
    const { image, bytes, contentType } = await getImageFile(id);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": contentType, "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${image.id}.${image.format}"`
    } });
  } catch (error) { return apiError(error, { fallbackMessage: "读取图片失败" }); }
}
