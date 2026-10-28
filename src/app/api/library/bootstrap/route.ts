import { z } from "zod";
import { apiJson } from "@/lib/api-route";
import { getLibraryBootstrap } from "@/lib/library-bootstrap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const querySchema = z.object({
  account: z.string().max(160).optional(), video: z.string().max(128).optional(),
  q: z.string().max(1000).optional(), vq: z.string().max(1000).optional(),
  videoStatus: z.string().max(32).optional(), sort: z.string().max(32).optional(), dir: z.string().max(8).optional()
});

export async function GET(request: Request) {
  const response = await apiJson(async () => {
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return getLibraryBootstrap(new URLSearchParams(query));
  }, { fallbackMessage: "读取资料库首屏失败，请刷新重试" });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
