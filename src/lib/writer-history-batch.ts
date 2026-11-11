import { z } from "zod";
import type { DraftSummary } from "./types";

const savedBatchSchema = z.object({
  kind: z.literal("write-batch"),
  results: z.array(z.object({ draft: z.object({
    id: z.string(), version: z.object({ sessionId: z.string() }).passthrough().optional()
  }).passthrough().optional() }))
});

export const writerSessionId = (draft: DraftSummary) => draft.version?.sessionId || draft.id;

export type WriterHistorySession = {
  id: string;
  versions: DraftSummary[];
  latest: DraftSummary;
};

export type WriterHistoryProject = {
  id: string;
  title: string;
  sessions: WriterHistorySession[];
  latest: DraftSummary;
  versionCount: number;
};

export function groupWriterHistoryProjects(drafts: DraftSummary[]): WriterHistoryProject[] {
  const bySession = new Map<string, DraftSummary[]>();
  for (const draft of drafts) {
    const id = writerSessionId(draft);
    const versions = bySession.get(id) || [];
    versions.push(draft);
    bySession.set(id, versions);
  }

  const byProject = new Map<string, WriterHistorySession[]>();
  for (const [id, versions] of bySession) {
    versions.sort((a, b) => (b.version?.revision || 1) - (a.version?.revision || 1) || +new Date(b.createdAt) - +new Date(a.createdAt));
    const session = { id, versions, latest: versions[0] };
    const projectId = session.latest.version?.batchId || id;
    const sessions = byProject.get(projectId) || [];
    sessions.push(session);
    byProject.set(projectId, sessions);
  }

  return [...byProject].map(([id, sessions]) => {
    sessions.sort((a, b) => +new Date(b.latest.createdAt) - +new Date(a.latest.createdAt));
    const latest = sessions[0].latest;
    return {
      id,
      title: latest.version?.batchId ? latest.title.split(/\s+·\s+/)[0] : latest.title,
      sessions,
      latest,
      versionCount: sessions.reduce((total, session) => total + session.versions.length, 0)
    };
  }).sort((a, b) => +new Date(b.latest.createdAt) - +new Date(a.latest.createdAt));
}

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
