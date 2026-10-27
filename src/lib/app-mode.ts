import type { JobKind } from "./types";

export type AppMode = "workspace" | "gross-margin";

export function getAppMode(): AppMode {
  return process.env.APP_MODE === "gross-margin" ? "gross-margin" : "workspace";
}

export function isGrossMarginAppMode() {
  return getAppMode() === "gross-margin";
}

export function isJobKindAllowedForAppMode(kind: JobKind, appMode: AppMode = getAppMode()) {
  return appMode === "workspace" || kind === "gross-margin-refresh";
}

export function assertJobKindAllowedForAppMode(kind: JobKind, appMode: AppMode = getAppMode()) {
  if (isJobKindAllowedForAppMode(kind, appMode)) return;

  const error = new Error("当前运行模式只允许执行毛利数据刷新任务。") as Error & { statusCode: number };
  error.statusCode = 403;
  throw error;
}
