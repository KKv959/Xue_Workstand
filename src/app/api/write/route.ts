import { writeCopy } from "@/lib/ai";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { directWriteCopyInputSchema } from "@/lib/write-validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return apiJson(async () => writeCopy(await parseJsonBody(request, directWriteCopyInputSchema), { signal: request.signal }), {
    fallbackMessage: "生成文案失败"
  });
}
