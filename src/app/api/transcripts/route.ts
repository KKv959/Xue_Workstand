import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { deleteTranscript, getTranscriptSnapshot, restoreTranscriptVersion, saveTranscript } from "@/lib/storage";
import { platforms } from "@/lib/types";
import { safeSegment } from "@/lib/utils";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(platforms),
  accountId: z.string().refine(isSafeAccountId, "账号标识不合法"),
  videoId: z.string().refine(isSafeSegment, "视频标识不合法")
});

const updateSchema = schema.extend({
  transcript: z.string(),
  expectedRevision: z.string().nullable()
});

const restoreSchema = schema.extend({
  versionId: z.string().refine(isSafeSegment, "版本标识不合法"),
  expectedRevision: z.string().nullable()
});

function isSafeSegment(value: string) {
  const normalized = value.trim();
  return normalized.length <= 128 && normalized === safeSegment(normalized) && !normalized.includes("..");
}

function isSafeAccountId(value: string) {
  const normalized = value.trim();
  const slug = normalized.includes(":") ? normalized.split(":").at(-1) || "" : normalized;
  return normalized.length <= 160 && isSafeSegment(slug) && normalized.split(":").length <= 2;
}

export async function GET(request: Request) {
  return apiJson(async () => {
    const url = new URL(request.url);
    const input = schema.parse({
      platform: url.searchParams.get("platform"),
      accountId: url.searchParams.get("accountId"),
      videoId: url.searchParams.get("videoId")
    });
    return getTranscriptSnapshot(input.platform, input.accountId, input.videoId);
  }, {
    fallbackMessage: "读取转写稿失败"
  });
}

export async function PUT(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, updateSchema);
    const result = await saveTranscript({
      platform: input.platform,
      accountId: input.accountId,
      videoId: input.videoId,
      text: input.transcript,
      source: "manual",
      expectedRevision: input.expectedRevision
    });
    return {
      transcript: result.transcript,
      revision: result.revision,
      previousVersionCreated: result.previousVersionCreated,
      versions: (await getTranscriptSnapshot(input.platform, input.accountId, input.videoId)).versions
    };
  }, {
    fallbackMessage: "保存转写稿失败"
  });
}

export async function PATCH(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, restoreSchema);
    const result = await restoreTranscriptVersion(input);
    return {
      transcript: result.transcript,
      revision: result.revision,
      previousVersionCreated: result.previousVersionCreated,
      versions: (await getTranscriptSnapshot(input.platform, input.accountId, input.videoId)).versions
    };
  }, {
    fallbackMessage: "恢复转写历史版本失败"
  });
}

export async function DELETE(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    return deleteTranscript(input.platform, input.accountId, input.videoId);
  }, {
    fallbackMessage: "删除转写稿失败"
  });
}
