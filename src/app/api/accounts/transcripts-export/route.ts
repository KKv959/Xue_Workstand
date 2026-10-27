import { NextResponse } from "next/server";
import { z } from "zod";
import { createAccountTranscriptDocx } from "@/lib/account-transcript-export";
import { apiError } from "@/lib/api-route";
import { platforms } from "@/lib/types";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(platforms),
  accountId: z.string().min(1)
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const input = schema.parse({
      platform: searchParams.get("platform"),
      accountId: searchParams.get("accountId")
    });
    const videoIds = searchParams.getAll("videoId").filter(Boolean);
    const result = await createAccountTranscriptDocx(input.platform, input.accountId, videoIds.length ? videoIds : undefined);
    const headers = new Headers({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
      "Cache-Control": "no-store",
      "X-Transcript-Count": String(result.transcriptCount)
    });

    return new NextResponse(new Uint8Array(result.buffer), { headers });
  } catch (error) {
    return apiError(error, {
      fallbackMessage: "导出转写稿失败"
    });
  }
}
