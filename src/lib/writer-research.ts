// Inspired by Vane's speed mode: focused search, then pass useful material to writing.
// https://github.com/ItzCrazyKns/Vane/tree/master/src/lib/agents/search
export const WRITER_SEARCH_TIMEOUT_MS = 60_000;
export const WRITER_SEARCH_MAX_OUTPUT_TOKENS = 5000;

// Compatibility for saved drafts from the former facts/notes format. New research
// is plain text. Never strip uncertainty from user material or generated copy.
export function writerResearchForWriting(research: string): string {
  return research.replace(/【检索记录，仅供查阅】[\s\S]*?【检索记录结束】/g, "").trim();
}
