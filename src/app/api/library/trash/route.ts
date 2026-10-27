import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { listLibraryTrashOperations, restoreLibraryTrashOperation } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const restoreSchema = z.object({
  action: z.literal("restore"),
  operationId: z.string().trim().min(1)
});

export async function GET() {
  return apiJson(async () => ({ operations: await listLibraryTrashOperations() }), {
    fallbackMessage: "读取素材库回收站失败",
    status: 500
  });
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, restoreSchema);
    return { operation: await restoreLibraryTrashOperation(input.operationId) };
  }, {
    fallbackMessage: "恢复素材库删除记录失败"
  });
}
