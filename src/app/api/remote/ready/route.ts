import { constants, promises as fs } from "node:fs";
import { getAppMode } from "@/lib/app-mode";
import { libraryRoot } from "@/lib/storage/core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 发布探针只检查应用和存储；外部能力仍由 remote/status 显式报告。
export async function GET() {
  let storage = "ok";
  try {
    if (!(await fs.stat(libraryRoot())).isDirectory()) throw new Error("资料库路径不是目录");
    await fs.access(libraryRoot(), constants.R_OK | constants.W_OK);
  } catch {
    storage = "unavailable";
  }
  const ready = storage === "ok";
  return Response.json({
    ready,
    buildId: process.env.APP_BUILD_ID || null,
    appMode: getAppMode(),
    serviceMode: process.env.NODE_ENV === "production" ? "production" : "development",
    storage,
    checkedAt: new Date().toISOString()
  }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
