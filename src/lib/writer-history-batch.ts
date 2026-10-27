import { z } from "zod";
import type { DraftSummary } from "./types";

const savedBatchSchema = z.object({
  kind: z.literal("write-batch"),
  results: z.array(z.object({ draft: z.object({
    id: z.string(), version: z.object({ sessionId: z.string() }).passthrough().optional()
  }).passthrough().optional() }))
});

export const writerSessionId = (draft: DraftSummary) => draft.version?.sessionId || draft.id;

/** Read exact persisted associations only; never infer a batch from similar text or dates. */
export function savedBatchSessions(result: unknown, selected: DraftSummary): string[] {
  const parsed = savedBatchSchema.safeParse(result);
  if (!parsed.success) return [];
  const sessions = parsed.data.results.flatMap(({ draft }) => draft ? [draft.version?.sessionId || draft.id] : []);
  return sessions.includes(writerSessionId(selected)) ? [...new Set(sessions)] : [];
}

export function selectWriterBatchDrafts(selected: DraftSummary, drafts: DraftSummary[], legacySessions: string[] = []) {
  const batchId = selected.version?.batchId;
  const sessions = new Set(legacySessions);
  const latest = new Map<string, DraftSummary>();
  for (const draft of drafts) {
    if (batchId ? draft.version?.batchId !== batchId : !sessions.has(writerSessionId(draft))) continue;
    const key = writerSessionId(draft);
    const previous = latest.get(key);
    if (!previous || (draft.version?.revision || 1) > (previous.version?.revision || 1) ||
        ((draft.version?.revision || 1) === (previous.version?.revision || 1) && draft.createdAt > previous.createdAt)) latest.set(key, draft);
  }
  // An explicitly opened old version stays selected; siblings use their latest saved version.
  latest.set(writerSessionId(selected), selected);
  return [...latest.values()].sort((a, b) => writerSessionId(a).localeCompare(writerSessionId(b)));
}
