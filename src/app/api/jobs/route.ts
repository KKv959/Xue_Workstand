import { apiJson, parseJsonBody } from "@/lib/api-route";
import { createJob, getJobReadErrors, getJobRecoveryErrors, listJobSummaryChanges } from "@/lib/jobs";
import { startJobSchema } from "@/lib/job-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiJson(async () => ({
    ...await listJobSummaryChanges(new URL(request.url).searchParams.get("cursor") || undefined),
    readErrors: getJobReadErrors(),
    recoveryErrors: getJobRecoveryErrors()
  }), {
    fallbackMessage: "读取任务失败",
    status: 500
  });
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, startJobSchema);
    if (input.kind === "engagement") delete input.checkpointId;
    const job = await createJob(input);
    return { job, jobId: job.id };
  }, {
    fallbackMessage: "创建任务失败"
  });
}
