import { randomUUID } from "node:crypto";
import { chatCompleteStrict } from "./ai";
import { resolveAiPolicy } from "./ai-policy-runtime";
import { writeEngagementCache } from "./storage";
import { engagementModelCallSchema } from "./storage/schemas";
import { nowIso, shortHash } from "./utils";
import type { z } from "zod";

/** 记录传给统一模型运行时的真实消息；不记录密钥、地址或请求头。重试包含在调用耗时内。 */
export async function auditedCommentModelCall(
  messages: Parameters<typeof chatCompleteStrict>[0],
  effort: Parameters<typeof chatCompleteStrict>[1],
  options: NonNullable<Parameters<typeof chatCompleteStrict>[2]> & { auditScope?: string } = {}
) {
  const { auditScope = "standalone", ...request } = options;
  const key = shortHash(auditScope) + "-" + randomUUID();
  const record: z.infer<typeof engagementModelCallSchema> = {
    schemaVersion: 1, scope: auditScope, policy: request.policy, startedAt: nowIso(), status: "running",
    configured: request.policy ? await resolveAiPolicy(request.policy) : undefined,
    messages: structuredClone(messages), retries: []
  };
  const save = () => writeEngagementCache("model-calls", key, engagementModelCallSchema.parse(record));
  await save();
  const started = Date.now();
  let result: Awaited<ReturnType<typeof chatCompleteStrict>>;
  try {
    result = await chatCompleteStrict(messages, effort, {
      ...request,
      async onRetry(message) {
        record.retries.push({ at: nowIso(), message });
        await save();
        await request.onRetry?.(message);
      }
    });
  } catch (error) {
    record.status = request.signal?.aborted ? "cancelled" : "failed";
    record.error = error instanceof Error ? error.message : "评论模型调用失败";
    record.completedAt = nowIso(); record.elapsedMs = Date.now() - started;
    await save();
    throw error;
  }
  record.status = "completed"; record.completedAt = nowIso(); record.elapsedMs = Date.now() - started;
  record.actual = { model: result.model, wireApi: result.wireApi, reasoningEffort: result.reasoningEffort, backend: result.backend, fallback: result.fallback, fallbackReason: result.fallbackReason };
  record.responseText = result.text;
  await save();
  return result;
}
