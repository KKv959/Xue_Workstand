// 第一阶段仅支持与工作台同一台 Mac 上的 NewsNow。
export const NEWSNOW_ORIGIN = "http://localhost:4444";
export const NEWSNOW_URL = `${NEWSNOW_ORIGIN}/c/hottest`;

export type NewsNowStatus = { available: boolean; message: string };

export const NEWSNOW_BRIDGE_CHANNEL = "workbench-newsnow";
export const NEWSNOW_BRIDGE_VERSION = 1;

export type NewsNowWorkbenchState = {
  total: number;
  hidden: number;
  refreshing: boolean;
  completed: number;
  failures: { id: string; label: string; reason: string }[];
  message: string;
  storageError: string;
};

export type NewsNowWorkbenchCommand = {
  channel: typeof NEWSNOW_BRIDGE_CHANNEL;
  version: typeof NEWSNOW_BRIDGE_VERSION;
  type: "connect" | "refresh" | "cancel" | "manage";
  tokens?: Record<string, string>;
  reducedMotion?: boolean;
};

export type NewsNowWorkbenchMessage = {
  channel: typeof NEWSNOW_BRIDGE_CHANNEL;
  version: typeof NEWSNOW_BRIDGE_VERSION;
  type: "state";
  state: NewsNowWorkbenchState;
};
