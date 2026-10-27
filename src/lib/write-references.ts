import type { Draft, Platform, WriteStyleReference, WriteStyleReferenceInput } from "./types";

type WriteReferenceSelection = {
  targetType?: "account" | "project";
  platform?: Platform;
  accountId?: string;
  projectId?: string;
  styleRefs?: WriteStyleReferenceInput[];
};

export function normalizeWriteStyleReferenceInputs(input: WriteReferenceSelection): WriteStyleReferenceInput[] {
  const requested = input.styleRefs?.length ? input.styleRefs : legacyWriteStyleReferenceInputs(input);
  const seen = new Set<string>();

  return requested.filter((reference) => {
    const key = writeStyleReferenceKey(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function draftWriteStyleReferenceInputs(draft: Draft): WriteStyleReferenceInput[] {
  if (draft.styleRefs?.length) {
    return draft.styleRefs.map(toWriteStyleReferenceInput);
  }

  return draft.targetType === "project"
    ? [{ targetType: "project", projectId: draft.projectId }]
    : [{ targetType: "account", platform: draft.platform, accountId: draft.accountId }];
}

export function writeStyleReferenceKey(reference: WriteStyleReferenceInput | WriteStyleReference) {
  return reference.targetType === "project"
    ? `project:${reference.projectId}`
    : `account:${reference.platform}:${reference.accountId}`;
}

export function parseWriteStyleReferenceKey(value: string): WriteStyleReferenceInput | null {
  if (value.startsWith("project:")) {
    const projectId = value.slice("project:".length).trim();
    return projectId ? { targetType: "project", projectId } : null;
  }

  if (!value.startsWith("account:")) return null;
  const remainder = value.slice("account:".length);
  const separatorIndex = remainder.indexOf(":");
  if (separatorIndex < 0) return null;
  const platform = remainder.slice(0, separatorIndex) as Platform;
  const accountId = remainder.slice(separatorIndex + 1).trim();
  if ((platform !== "bilibili" && platform !== "douyin") || !accountId) return null;
  return { targetType: "account", platform, accountId };
}

function legacyWriteStyleReferenceInputs(input: WriteReferenceSelection): WriteStyleReferenceInput[] {
  if ((input.targetType === "project" || input.projectId) && input.projectId) {
    return [{ targetType: "project", projectId: input.projectId }];
  }
  if (input.platform && input.accountId) {
    return [{ targetType: "account", platform: input.platform, accountId: input.accountId }];
  }
  return [];
}

function toWriteStyleReferenceInput(reference: WriteStyleReference): WriteStyleReferenceInput {
  return reference.targetType === "project"
    ? { targetType: "project", projectId: reference.projectId }
    : { targetType: "account", platform: reference.platform, accountId: reference.accountId };
}
