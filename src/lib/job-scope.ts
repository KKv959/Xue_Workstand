import type { Draft, Platform, WriteStyleReferenceInput } from "./types";
import { splitWriterSourceInput } from "./source-extraction";
import { normalizeWriteStyleReferenceInputs, writeStyleReferenceKey } from "./write-references";

export type WriteCopyScopeInput = {
  action?: "create" | "revise";
  targetType?: "account" | "project";
  platform?: Platform;
  accountId?: string;
  projectId?: string;
  styleRefs?: WriteStyleReferenceInput[];
  mode: Draft["mode"];
  prompt?: string;
  sourceText?: string;
  supportDocLinks?: string;
  useWebResearch?: boolean;
  parentDraftId?: string;
  revisionTargets?: Array<{ parentDraftId: string; currentContent: string }>;
  currentContent?: string;
  revisionInstruction?: string;
  revisionScope?: "full" | "selection";
  selectedText?: string;
};

export function writeCopySourceKey(input: WriteCopyScopeInput) {
  const separatedInput = splitWriterSourceInput(input.sourceText || "", input.supportDocLinks || "");
  const styleRefs = normalizeWriteStyleReferenceInputs(input).map(writeStyleReferenceKey);
  return stableScopeHash(JSON.stringify({
    action: input.action || "create",
    targetType: input.targetType || "account",
    platform: input.platform || "",
    accountId: input.accountId || "",
    projectId: input.projectId || "",
    styleRefs,
    mode: input.mode,
    prompt: normalizeScopeText(input.prompt),
    sourceText: normalizeScopeText(separatedInput.sourceText),
    supportDocLinks: normalizeScopeLinks(separatedInput.supportDocLinks),
    useWebResearch: Boolean(input.useWebResearch),
    parentDraftId: input.parentDraftId || "",
    ...(input.revisionTargets ? { revisionTargets: input.revisionTargets.map(item => ({ parentDraftId: item.parentDraftId, currentContent: normalizeScopeText(item.currentContent) })) } : {}),
    currentContent: normalizeScopeText(input.currentContent),
    revisionInstruction: normalizeScopeText(input.revisionInstruction),
    revisionScope: input.revisionScope || "full",
    selectedText: normalizeScopeText(input.selectedText)
  }));
}

export function engagementSourceKey(input: {
  sourceType: "text";
  text: string;
  includeComments?: boolean;
  commentCount?: number;
  includeDanmaku?: boolean;
  danmakuCount?: number;
  targetPlatform?: Platform;
} | {
  sourceType: "url";
  url: string;
  includeComments?: boolean;
  commentCount?: number;
  includeDanmaku?: boolean;
  danmakuCount?: number;
  targetPlatform?: Platform;
} | {
  sourceType: "record";
  recordId: string;
  includeComments?: boolean;
  commentCount?: number;
  includeDanmaku?: boolean;
  danmakuCount?: number;
  targetPlatform?: Platform;
}) {
  return stableScopeHash(JSON.stringify({
    sourceType: input.sourceType,
    source: input.sourceType === "url"
      ? normalizeScopeText(input.url)
      : input.sourceType === "record"
        ? input.recordId
        : normalizeScopeText(input.text),
    includeComments: input.includeComments ?? true,
    commentCount: input.commentCount ?? 50,
    includeDanmaku: input.includeDanmaku ?? false,
    danmakuCount: input.danmakuCount ?? 50,
    targetPlatform: input.targetPlatform || ""
  }));
}

function normalizeScopeText(value?: string) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeScopeLinks(value?: string) {
  return (value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function stableScopeHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${value.length.toString(36)}`;
}
