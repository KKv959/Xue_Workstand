import type { NewsNowWorkbenchMessage } from "./newsnow";

export const NEWSNOW_LAYOUT_KEY = "workbench:newsnow:layout:v1";
export type NewsNowLayout = { schemaVersion: 1; order: string[]; hidden: string[] };

export function readNewsNowLayout(raw: string | null, sources: string[]): NewsNowLayout {
  if (!raw) return { schemaVersion: 1, order: [...sources], hidden: [] };
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("卡片偏好格式损坏，请在管理卡片中重置布局。");
  const record = value as Partial<NewsNowLayout>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.order) || !Array.isArray(record.hidden)
    || ![...record.order, ...record.hidden].every(id => typeof id === "string")) {
    throw new Error("卡片偏好版本或格式不兼容，请在管理卡片中重置布局。");
  }
  const known = new Set(sources);
  const order = [...new Set(record.order.filter(id => known.has(id)))];
  return {
    schemaVersion: 1,
    order: [...order, ...sources.filter(id => !order.includes(id))],
    hidden: [...new Set(record.hidden.filter(id => known.has(id)))],
  };
}

export function moveNewsNowCard(order: string[], id: string, over: string): string[] {
  const from = order.indexOf(id), to = order.indexOf(over);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function isNewsNowWorkbenchMessage(value: unknown): value is NewsNowWorkbenchMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<NewsNowWorkbenchMessage>;
  const state = message.state;
  return message.channel === "workbench-newsnow" && message.version === 1 && message.type === "state"
    && !!state && Number.isInteger(state.total) && state.total >= 0
    && Number.isInteger(state.hidden) && state.hidden >= 0 && state.hidden <= state.total
    && Number.isInteger(state.completed) && state.completed >= 0 && state.completed <= state.total
    && typeof state.refreshing === "boolean" && typeof state.message === "string" && typeof state.storageError === "string"
    && Array.isArray(state.failures) && state.failures.length <= state.total
    && state.failures.every(item => item && typeof item.id === "string" && typeof item.label === "string" && typeof item.reason === "string");
}

// Workers share only a read cursor; each source owns its request and existing NewsNow cache entry.
export async function refreshNewsNowSources(
  sources: string[],
  refresh: (id: string) => Promise<void>,
  signal: AbortSignal,
  onResult: (id: string, error?: unknown) => void,
) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (!signal.aborted && cursor < sources.length) {
      const id = sources[cursor++];
      try {
        await refresh(id);
        if (!signal.aborted) onResult(id);
      } catch (error) {
        if (!signal.aborted) onResult(id, error);
      }
    }
  }));
}
