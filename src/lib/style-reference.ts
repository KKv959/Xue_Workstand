import { shortHash } from "./utils";

// Learn from complete originals. Exact duplicates add no evidence; ranking or excerpts lose context.
export const STYLE_REFERENCE_VERSION = 3;
type Source = { video: { id: string; title: string }; transcript: string };

export function collectStyleOriginals(sources: Source[]) {
  const seen = new Set<string>();
  return sources.filter(source => {
    const fingerprint = shortHash(source.transcript.replace(/\s+/gu, ""));
    if (!source.transcript.trim() || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  }).map(source => ({ id: source.video.id, title: source.video.title, text: source.transcript }));
}
