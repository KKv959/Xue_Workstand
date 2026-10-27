import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { deleteVideos } from "@/lib/storage";
import { platforms } from "@/lib/types";

export const runtime = "nodejs";

const deleteSchema = z.object({
  platform: z.enum(platforms),
  accountId: z.string().min(1),
  videoIds: z.array(z.string().min(1)).min(1)
});

export async function DELETE(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, deleteSchema);
    return deleteVideos(input.platform, input.accountId, input.videoIds);
  }, {
    fallbackMessage: "删除视频失败"
  });
}
