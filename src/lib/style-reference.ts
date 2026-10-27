import { shortHash } from "./utils";

// A few originals are enough to distill a card; no scoring, planning or per-source model call.
export const STYLE_REFERENCE_VERSION = 2;
export const STYLE_REFERENCE_CANDIDATES = 8;
type Source = { video: { id: string; title: string }; transcript: string };

// Keep continuous passages and explicitly mark gaps; never turn distant sentences into a quotation.
export function sourcePassages(text: string, budget: number) {
  if (text.length <= budget) return [text];
  const size = Math.floor(budget / 3);
  return [0, Math.floor((text.length - size) / 2), text.length - size].map(start => {
    const slice = text.slice(start, start + size);
    const firstBoundary = start === 0 ? -1 : slice.search(/[。！？\n]/u);
    const endBoundary = Math.max(slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"), slice.lastIndexOf("\n"));
    const from = firstBoundary >= 0 && firstBoundary < size / 3 ? firstBoundary + 1 : 0;
    const to = start + size < text.length && endBoundary > size * 2 / 3 ? endBoundary + 1 : slice.length;
    return slice.slice(from, to).trim();
  }).filter(Boolean);
}

export function selectStyleReferences(sources: Source[]) {
  const limit = 3;
  const budget = 6000;
  const seen = new Set<string>();
  const unique = sources.filter(source => {
    const fingerprint = shortHash(source.transcript.replace(/\s+/gu, ""));
    if (!source.transcript.trim() || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
  const count = Math.min(limit, unique.length);
  // Spread examples across the available originals instead of selecting only the first entries.
  const selected = Array.from({ length: count }, (_, i) => unique[count === 1 ? 0 : Math.round(i * (unique.length - 1) / (count - 1))]);
  return selected.map(source => {
    const passages = sourcePassages(source.transcript, budget);
    const text = passages.join("\n\n[中间原文省略，以下为另一连续片段]\n\n");
    return { id: source.video.id, title: source.video.title, text, passages };
  });
}
