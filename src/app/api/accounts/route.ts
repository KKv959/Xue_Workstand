import { z } from "zod";
import { apiJson, parseJsonBody } from "@/lib/api-route";
import { resolveAccountProfile } from "@/lib/account-profile";
import { deleteAccounts, findAccountByName, getAccountDetail, getAccountSummary, upsertAccount } from "@/lib/storage";
import { platforms } from "@/lib/types";
import { resolveAccountUid } from "@/lib/opencli";
import { normalizeLinkInput } from "@/lib/platform-links";

export const runtime = "nodejs";

const schema = z.object({
  platform: z.enum(platforms),
  name: z.string().min(1),
  uidOrUrl: z.string().optional(),
  sourceUrl: z.string().optional()
});

const deleteSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1)
});

export async function GET(request: Request) {
  return apiJson(async () => {
    const { searchParams } = new URL(request.url);
    const input = z.object({
      platform: z.enum(platforms),
      accountId: z.string().min(1)
    }).parse({
      platform: searchParams.get("platform"),
      accountId: searchParams.get("accountId")
    });
    return getAccountDetail(input.platform, input.accountId, {
      includeStyle: parseBooleanFlag(searchParams.get("includeStyle"))
    });
  }, {
    fallbackMessage: "读取账号详情失败"
  });
}

function parseBooleanFlag(value: string | null) {
  return value === "1" || value === "true";
}

export async function POST(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, schema);
    const uidOrUrl = normalizeAccountLinkInput(input.uidOrUrl);
    const sourceUrl = normalizeAccountLinkInput(input.sourceUrl);
    const existing = !uidOrUrl ? await findAccountByName(input.platform, input.name) : null;
    const uid = existing?.uid || await resolveAccountUid(input.platform, input.name, uidOrUrl, { signal: request.signal });
    const profile = await resolveAccountProfile({
      platform: input.platform,
      uid,
      fallbackName: existing?.name || input.name,
      sourceUrl: sourceUrl || uidOrUrl || existing?.sourceUrl || input.name,
      signal: request.signal
    });
    const account = await upsertAccount({
      platform: input.platform,
      name: profile.name,
      uid,
      sourceUrl: profile.sourceUrl,
      avatarUrl: profile.avatarUrl
    });

    return getAccountSummary(account);
  }, {
    fallbackMessage: "保存账号失败"
  });
}

function normalizeAccountLinkInput(input?: string) {
  return input ? normalizeLinkInput(input, { kind: "account" }) : "";
}

export async function DELETE(request: Request) {
  return apiJson(async () => {
    const input = await parseJsonBody(request, deleteSchema);
    return deleteAccounts(input.accountIds);
  }, {
    fallbackMessage: "删除账号失败"
  });
}
