import { z } from "zod";
import { apiError } from "@/lib/api-route";
import { getGrossMarginMonitorAvatar } from "@/lib/gross-margin-avatars";
import { resolveGrossMarginMonitorRecord } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const id = z.string().trim().min(1, "缺少监控记录 ID。")
      .parse(new URL(request.url).searchParams.get("recordId") || "");
    const record = await resolveGrossMarginMonitorRecord(id);
    const { bytes, contentType } = await getGrossMarginMonitorAvatar(record, request.signal);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400"
    } });
  } catch (error) {
    return apiError(error, { fallbackMessage: "加载账号头像失败，请刷新页面重试。" });
  }
}
