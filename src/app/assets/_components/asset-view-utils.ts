import { formatPlatform } from "@/components/Formatters";
import type { Draft, EngagementSourceType } from "@/lib/types";

export type BusyState = "generate" | "feishu-comments" | "feishu-danmaku" | "export-word" | "";

export function getDraftReferenceLabel(draft: Draft) {
  return draft.targetType === "project" ? `项目 ${draft.projectName}` : `${formatPlatform(draft.platform)} / ${draft.accountName}`;
}

export function formatSourceType(sourceType: EngagementSourceType) {
  if (sourceType === "draft") return "草稿";
  if (sourceType === "text") return "粘贴";
  return "链接";
}

export function formatTime(seconds: number) {
  const minute = Math.floor(seconds / 60);
  const second = seconds % 60;
  return `${minute}:${String(second).padStart(2, "0")}`;
}

export function hasSourceInput(sourceInput: string) {
  return Boolean(sourceInput.trim());
}
