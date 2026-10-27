import { isJobExecuting, listJobSummaries } from "@/lib/jobs";
import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { assertJobKindAllowedForAppMode } from "@/lib/app-mode";
import { deleteImageRecords, getImageRecord, listImageRecords } from "@/lib/storage/images";
import { imageCanvasIdSchema } from "@/lib/image-generation-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return apiJson(async () => {
    assertJobKindAllowedForAppMode("image-generation");
    const offset = z.coerce.number().int().min(0).parse(new URL(request.url).searchParams.get("offset") || 0);
    const canvasId = imageCanvasIdSchema.optional().parse(new URL(request.url).searchParams.get("canvasId") || undefined);
    const limit = z.coerce.number().int().min(1).parse(new URL(request.url).searchParams.get("limit") || 40);
    return listImageRecords(offset, limit, canvasId);
  }, { fallbackMessage: "读取生图历史失败" });
}

const deleteSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), id: imageCanvasIdSchema }),
  z.object({ action: z.literal("clear-failed") })
]);
export async function DELETE(request: Request) {
  return apiJson(async () => {
    assertJobKindAllowedForAppMode("image-generation");
    const input = await parseJsonBody(request, deleteSchema);
    const jobs = await listJobSummaries({ all: true });
    if (input.action === "delete") {
      const job = jobs.find((item) => item.id === input.id);
      if (isJobExecuting(input.id) || (job && (job.status === "running" || job.status === "queued"))) throw Object.assign(new Error("图片仍在生成，请等待完成或停止后再删除。"), { statusCode: 409 });
      return deleteImageRecords([input.id]);
    }
    const ids: string[] = [];
    for (const job of jobs) {
      if (job.kind !== "image-generation" || job.status !== "failed" || isJobExecuting(job.id)) continue;
      const record = await getImageRecord(job.id);
      if (record && !record.deletedAt && !record.images.length) ids.push(record.id);
    }
    return deleteImageRecords(ids);
  }, { fallbackMessage: "删除生图记录失败" });
}
