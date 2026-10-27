import { apiError } from "@/lib/api-route";
import { getDraftAssetFile } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const draftId = url.searchParams.get("draftId") || "";
    const path = url.searchParams.get("path") || "";
    if (!draftId || !path) throw new Error("缺少素材路径");
    const file = await getDraftAssetFile(draftId, path);
    return new Response(file.bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return apiError(error, {
      fallbackMessage: "读取素材失败"
    });
  }
}
