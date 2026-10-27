import { NextResponse } from "next/server";
import { getRemoteStatus } from "@/lib/remote-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";
  return NextResponse.json(await getRemoteStatus({ fresh }), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
