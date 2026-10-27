import { apiJson } from "@/lib/api-route";
import { buildRefreshLogEntries } from "@/lib/douyin-hotlist-refresh-log";
import { getJob, listJobSummaries } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const response = await apiJson(async () => {
    const summaries = (await listJobSummaries())
      .filter((job) => job.kind === "hotlist-refresh" && !["queued", "running"].includes(job.status))
      .slice(0, 6);
    const jobs = await Promise.all(summaries.map((job) => getJob(job.id)));
    return { logs: buildRefreshLogEntries(jobs) };
  }, {
    fallbackMessage: "读取共享刷新日志失败"
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
