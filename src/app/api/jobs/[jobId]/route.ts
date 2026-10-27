import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { cancelJob, getJob, retryJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  return apiJson(async () => {
    const { jobId } = await params;
    return { job: await getJob(jobId) };
  }, {
    fallbackMessage: "读取任务失败",
    status: 404
  });
}

const patchSchema = z.object({
  action: z.enum(["cancel", "retry"])
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, patchSchema);
    const { jobId } = await params;
    return { job: input.action === "cancel" ? await cancelJob(jobId) : await retryJob(jobId) };
  }, {
    fallbackMessage: "更新任务失败"
  });
}
