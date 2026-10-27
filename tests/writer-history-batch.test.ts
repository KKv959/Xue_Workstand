import assert from "node:assert/strict";
import test from "node:test";
import { savedBatchSessions, selectWriterBatchDrafts } from "../src/lib/writer-history-batch";
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
