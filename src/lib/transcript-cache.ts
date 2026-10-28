import type { Platform, TranscriptVersion } from "./types";

export type TranscriptIdentity = { platform: Platform; accountId: string; videoId: string; version?: string };
export type TranscriptSnapshot = { transcript: string; revision: string | null; versions: TranscriptVersion[] };
export type CachedTranscript = TranscriptSnapshot & { complete: boolean; error?: string };
const entries = new Map<string, { value: CachedTranscript; expires: number }>();
const pending = new Map<string, Promise<TranscriptSnapshot>>();
const TTL = 5 * 60_000;
const LIMIT = 30;
const MAX_TEXT_SIZE = 500_000;
const keyOf = (input: TranscriptIdentity) => JSON.stringify([input.platform, input.accountId, input.videoId]);

export function getCachedTranscript(input: TranscriptIdentity): CachedTranscript | null {
  const key = keyOf(input);
  const cached = entries.get(key);
  if (!cached) return null;
  if (cached.expires <= Date.now() || (input.version && cached.value.revision !== input.version)) {
    entries.delete(key);
    return null;
  }
  entries.delete(key);
  entries.set(key, cached);
  return cached.value;
}

export function rememberTranscript(input: TranscriptIdentity, value: CachedTranscript) {
  const key = keyOf(input);
  // 引导页摘要不得覆盖同版本的完整原稿。
  const current = getCachedTranscript({ ...input, version: value.revision || undefined });
  if (!value.complete && current?.complete) return;
  entries.delete(key);
  if (value.transcript.length > MAX_TEXT_SIZE) return;
  entries.set(key, { value, expires: Date.now() + TTL });
  while (entries.size > LIMIT) entries.delete(entries.keys().next().value!);
}

export function loadCachedTranscript(input: TranscriptIdentity, load: () => Promise<TranscriptSnapshot>) {
  const cached = getCachedTranscript(input);
  if (cached?.complete) return Promise.resolve(cached);
  // 版本参与在途请求键，旧版本请求不能满足新版本读取。
  const requestKey = JSON.stringify([input.platform, input.accountId, input.videoId, input.version || ""]);
  const existing = pending.get(requestKey);
  if (existing) return existing;
  // 新版本读取使该视频更早发出的请求失去写缓存资格。
  for (const other of pending.keys()) {
    const [p, a, v] = JSON.parse(other) as string[];
    if (p === input.platform && a === input.accountId && v === input.videoId) pending.delete(other);
  }
  const request = load().then(value => {
    if (pending.get(requestKey) === request) rememberTranscript(input, { ...value, complete: true });
    return value;
  }).finally(() => {
    if (pending.get(requestKey) === request) pending.delete(requestKey);
  });
  pending.set(requestKey, request);
  return request;
}

export function invalidateTranscriptCache(platform?: Platform, accountId?: string, videoId?: string) {
  const matches = (key: string) => {
    const [p, a, v] = JSON.parse(key) as string[];
    return (!platform || p === platform) && (!accountId || a === accountId) && (!videoId || v === videoId);
  };
  for (const key of entries.keys()) if (matches(key)) entries.delete(key);
  for (const key of pending.keys()) if (matches(key)) pending.delete(key);
}
