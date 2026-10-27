import { toNumber } from "./utils";

export function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const number = toNumber(value);
    if (number > 0) return number;
  }
  return 0;
}

export function normalizeCommentText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["text", "content", "message", "comment", "reply"]) {
      const text: string = normalizeCommentText(object[key]);
      if (text) return text;
    }
    return JSON.stringify(value);
  }
  return "";
}

export function containsPlatformUserMention(value: string) {
  return /[@＠]/u.test(value);
}

export function normalizeTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return normalizeTimestamp(Number(trimmed));
    return trimmed;
  }

  return "";
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function isRelatedVideoRelevant(title: string, query: string) {
  const normalizedTitle = normalizeSearchComparableText(title);
  if (!normalizedTitle) return false;
  const terms = extractRelatedSearchTerms(query);
  if (!terms.length) return true;

  const matched = terms.filter((term) => normalizedTitle.includes(normalizeSearchComparableText(term)));
  if (matched.length >= Math.min(2, terms.length)) return true;
  return matched.some((term) => Array.from(term).length >= 4);
}

export function isExcludedRelatedVideo(videoId: string, excludedVideoIds: string[] | undefined) {
  const key = videoId.trim().toLowerCase();
  if (!key) return false;
  return (excludedVideoIds || []).some((value) => value.trim().toLowerCase() === key);
}

/** 保留平台搜索名次，兼顾检索方向和作者差异；热度只用于同名次的比较。 */
export function selectRelatedCommentVideos<T extends { id: string; title: string; author?: string }>(
  groups: Array<{ query: string; videos: T[] }>, limit: number, compareHeat: (a: T, b: T) => number
): Array<T & { query: string }> {
  const merged = new Map<string, { video: T; rank: number; queries: string[] }>();
  for (const group of groups) group.videos.forEach((video, rank) => {
    const previous = merged.get(video.id);
    if (previous) { previous.rank = Math.min(previous.rank, rank); if (!previous.queries.includes(group.query)) previous.queries.push(group.query); }
    else merged.set(video.id, { video, rank, queries: [group.query] });
  });
  const candidates = [...merged.values()];
  const usedQueries = new Set<string>();
  const authors = new Set<string>();
  const titles = new Set<string>();
  const selected: Array<T & { query: string }> = [];
  while (selected.length < limit && candidates.length) {
    candidates.sort((a, b) =>
      Number(b.queries.some((q) => !usedQueries.has(q))) - Number(a.queries.some((q) => !usedQueries.has(q)))
      || Number(Boolean(a.video.author && authors.has(a.video.author))) - Number(Boolean(b.video.author && authors.has(b.video.author)))
      || Number(titles.has(a.video.title)) - Number(titles.has(b.video.title))
      || a.rank - b.rank || compareHeat(a.video, b.video));
    const next = candidates.shift()!;
    const query = next.queries.find((q) => !usedQueries.has(q)) || next.queries[0];
    selected.push({ ...next.video, query }); usedQueries.add(query);
    if (next.video.author) authors.add(next.video.author); titles.add(next.video.title);
  }
  return selected;
}

function extractRelatedSearchTerms(query: string) {
  return uniqueStrings(
    query
      .split(/[\s，,。.!！?？；;：:、｜|/\\()[\]{}<>《》“”"‘’#]+/)
      .map((term) => term.trim())
      .filter((term) => Array.from(term).length >= 2)
      .filter((term) => !RELATED_SEARCH_TERM_STOP_WORDS.has(term.toLowerCase()))
  ).slice(0, 8);
}

function normalizeSearchComparableText(value: string) {
  return value
    .replace(/\s+/g, "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9._-]+/g, "")
    .toLowerCase();
}

const RELATED_SEARCH_TERM_STOP_WORDS = new Set([
  "视频",
  "评论",
  "弹幕",
  "文案",
  "素材",
  "热点",
  "话题",
  "生成",
  "douyin",
  "抖音"
]);
