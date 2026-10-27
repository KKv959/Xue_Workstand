import { apiJson } from "@/lib/api-route";
import { assertJobKindAllowedForAppMode } from "@/lib/app-mode";
import { getImageMetadata, getImageRecord } from "@/lib/storage/images";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return apiJson(async () => {
    assertJobKindAllowedForAppMode("image-generation");
    const { id } = await context.params;
    const record = await getImageRecord(id);
    if (!record || record.deletedAt) throw Object.assign(new Error("生图记录尚未保存或不存在，请稍后刷新。"), { statusCode: 404 });
    const references = [];
    for (const referenceId of record.referenceIds) references.push(await getImageMetadata(referenceId));
    return { record, references };
  }, { fallbackMessage: "读取生图记录失败" });
}
