import type { Draft } from "./types";
import { draftWriteStyleReferenceInputs, writeStyleReferenceKey } from "./write-references";

export function buildWriterDraftHref(draft: Draft) {
  const params = new URLSearchParams({
    draftId: draft.id,
    mode: draft.mode,
    targetType: draft.targetType === "project" ? "project" : "account"
  });

  if (draft.targetType === "project") {
    params.set("projectId", draft.projectId);
  } else {
    params.set("accountId", draft.accountId);
  }

  for (const reference of draftWriteStyleReferenceInputs(draft)) {
    params.append("styleRef", writeStyleReferenceKey(reference));
  }

  return `/writer?${params.toString()}`;
}
