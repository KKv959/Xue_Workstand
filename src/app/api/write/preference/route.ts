import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { resolveDraft, readStyle, saveStyle } from "@/lib/storage";
import { draftWriteStyleReferenceInputs } from "@/lib/write-references";
import { addWriterPreference, removeWriterPreference } from "@/lib/writer-preference";
import { shortHash } from "@/lib/utils";

export const runtime = "nodejs";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remember"), draftId: z.string().min(1), text: z.string().trim().min(1, "请填写要记住的写作偏好。").max(600, "写作偏好最多 600 字。") }),
  z.object({ action: z.literal("undo"), draftId: z.string().min(1), preferenceId: z.string().uuid() })
]);
export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    const { draft } = await resolveDraft(input.draftId);
    const refs = draftWriteStyleReferenceInputs(draft);
    if (refs.length !== 1) throw Object.assign(new Error("请先选择一篇仅对应一个博主的稿件。"), { statusCode: 400 });
    const ref = refs[0];
    if (ref.targetType !== "account") throw Object.assign(new Error("项目写作已移除，无法修改项目写作偏好。"), { statusCode: 400 });
    const previous = await readStyle(ref.platform, ref.accountId);
    const preferenceId = input.action === "remember" ? randomUUID() : input.preferenceId;
    const content = input.action === "remember" ? addWriterPreference(previous, preferenceId, input.text) : removeWriterPreference(previous, preferenceId);
    const expected = shortHash(previous.trim());
    await saveStyle(ref.platform, ref.accountId, content, expected);
    return { preferenceId, reference: ref, action: input.action };
  }, { fallbackMessage: "保存写作偏好失败" });
}
