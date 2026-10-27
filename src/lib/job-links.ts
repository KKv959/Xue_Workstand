import type { JobKind, JobRecord } from "./types";

export function defaultJobHref(kind: JobKind) {
  if (kind === "image-generation" || kind === "image-prompt-assist") return "/images";
  if (kind === "image-cover") return "/writer";
  if (kind === "write-copy") return "/writer";
  if (kind === "project-style") return "/writer";
  if (kind === "engagement") return "/assets";
  if (kind === "hotlist-refresh") return "/douyin-hotlist";
  if (kind === "single-video-transcribe" || kind === "publish-copy") return "/tools";
  if (kind === "hotspot-refresh") return "/hotspots";
  if (kind === "gross-margin-refresh") return "/gross-margin/monitor";
  return "/library";
}

export const ENGAGEMENT_RECORD_QUERY_PARAM = "recordId";

export function buildEngagementRecordHref(recordId: string, baseHref = "/assets") {
  const [hrefWithoutHash, hash = ""] = baseHref.split("#", 2);
  const [pathname, query = ""] = hrefWithoutHash.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(ENGAGEMENT_RECORD_QUERY_PARAM, recordId);
  return `${pathname || "/assets"}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

export function getJobResultHref(job: Pick<JobRecord, "href" | "kind" | "resultRef">) {
  const href = job.resultRef?.href || job.href;
  if (job.kind === "engagement" && job.resultRef?.id) {
    return buildEngagementRecordHref(job.resultRef.id, href || "/assets");
  }
  return href;
}
