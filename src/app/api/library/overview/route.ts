import { apiJson } from "@/lib/api-route";
import { getLibraryOverview } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return apiJson(() => getLibraryOverview(), {
    fallbackMessage: "读取风格库概览失败",
    status: 500
  });
}
