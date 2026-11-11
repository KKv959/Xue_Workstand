import assert from "node:assert/strict";
import test from "node:test";
import { groupWriterHistoryProjects, savedBatchSessions, selectWriterBatchDrafts } from "../src/lib/writer-history-batch";
import type { DraftSummary } from "../src/lib/types";

function draft(id: string, sessionId: string, revision = 1, batchId?: string): DraftSummary {
  return { id, title: "相同标题", mode: "rewrite", platform: "douyin", accountId: sessionId, accountName: sessionId,
    createdAt: "2026-09-22", updatedAt: "2026-09-22",
    version: { sessionId, revision, batchId, origin: "generated", contextFingerprint: "test", promptVersion: "test" } };
}

test("restores siblings, selects latest per style but preserves explicitly selected old version", () => {
  const a1 = draft("a1", "a", 1, "batch");
  const a2 = draft("a2", "a", 2, "batch");
  const b1 = draft("b1", "b", 1, "batch");
  const b2 = draft("b2", "b", 2, "batch");
  assert.deepEqual(selectWriterBatchDrafts(a1, [b1, a2, draft("other", "c", 1, "other"), b2, a1]).map(d => d.id), ["a1", "b2"]);
});

test("legacy associations use persisted task session ids, never title or time", () => {
  const a = draft("a", "a"), b = draft("b", "b"), other = draft("other", "other");
  const result = { kind: "write-batch", results: [{ draft: a }, { draft: b }] };
  assert.deepEqual(savedBatchSessions(result, a), ["a", "b"]);
  assert.deepEqual(savedBatchSessions(result, other), []);
  assert.deepEqual(selectWriterBatchDrafts(a, [a, b, other], savedBatchSessions(result, a)).map(d => d.id), ["a", "b"]);
  assert.deepEqual(selectWriterBatchDrafts(a, [a, b, other]).map(d => d.id), ["a"]);
});

test("deleted siblings are not resurrected from job snapshots; malformed or compacted results are safe", () => {
  const a = draft("a", "a");
  assert.deepEqual(selectWriterBatchDrafts(a, [a], ["a", "deleted"]).map(d => d.id), ["a"]);
  for (const result of [undefined, {}, { kind: "write-batch", results: null }]) assert.deepEqual(savedBatchSessions(result, a), []);
});

test("groups one concurrent batch as one history project while retaining manuscripts and versions", () => {
  const drafts = [
    draft("a1", "a", 1, "batch"),
    draft("a2", "a", 2, "batch"),
    draft("b1", "b", 1, "batch"),
    draft("single", "single")
  ];
  drafts[0].title = drafts[1].title = "我的世界联动 · 风格甲";
  drafts[2].title = "我的世界联动 · 风格乙";

  const projects = groupWriterHistoryProjects(drafts);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].title, "我的世界联动");
  assert.equal(projects[0].sessions.length, 2);
  assert.equal(projects[0].versionCount, 3);
  assert.deepEqual(projects[0].sessions.map(session => session.latest.id).sort(), ["a2", "b1"]);
});
