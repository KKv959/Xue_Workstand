import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultJobHref } from "../src/lib/job-links";
import { parseStoredRecord } from "../src/lib/storage/schemas";
import { startJobSchema } from "../src/lib/job-validation";
import { jobKinds, type JobRecord } from "../src/lib/types";

const timestamp = "2026-05-19T00:00:00.000Z";
function fixture(id: string): JobRecord {
  return { id, kind: "image-generation", status: "completed", title: "兼容性测试", message: "完成", progress: 100, createdAt: timestamp, updatedAt: timestamp };
}
const imageInput = { prompt: "测试", size: "1024x1024", quality: "auto", count: 1, referenceIds: [] };

test("任务列表、详情和恢复共用兼容性边界，错误隔离且保留原文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "job-compatibility-"));
  const previous = process.env.STYLE_LIBRARY_DIR;
  process.env.STYLE_LIBRARY_DIR = root;
  const dir = path.join(root, "jobs");
  const payloadDir = path.join(dir, ".payloads");
  await mkdir(payloadDir, { recursive: true });
  const originals = new Map<string, string>();
  async function store(id: string, value: unknown, payload = false, indent = 2) {
    const target = path.join(payload ? payloadDir : dir, `${id}.json`);
    const raw = typeof value === "string" ? value : JSON.stringify(value, null, indent);
    originals.set(target, raw);
    await writeFile(target, raw);
  }
  try {
    for (const indent of [0, 2, 4]) await store(`legacy-${indent}`, { ...fixture(`legacy-${indent}`), result: { content: "x".repeat(128 * 1024) }, partialText: "" }, false, indent);
    await store("future-version", { ...fixture("future-version"), schemaVersion: 99 });
    await store("future-kind", { ...fixture("future-kind"), kind: "future-kind" });
    await store("bad-ref", { ...fixture("bad-ref"), resultRef: { href: 42, label: "查看" } });
    await store("bad-events", { ...fixture("bad-events"), events: [null] });
    await store("wrong-id", fixture("other-id"));
    await store("null-record", "null");
    await store("broken", JSON.stringify(fixture("broken"), null, 2).slice(0, -1));
    await store("trailing", JSON.stringify(fixture("trailing"), null, 2) + " garbage");
    for (const id of ["payload-future", "payload-invalid", "payload-mismatch"]) {
      await store(id, { ...fixture(id), status: "queued", progress: 0 });
    }
    await store("payload-future", { version: 2, input: { kind: "image-generation", input: imageInput } }, true);
    await store("payload-invalid", { version: 1, input: { kind: "image-generation" } }, true);
    await store("payload-mismatch", { version: 1, input: { kind: "hotspot-refresh", input: {} } }, true);
    await store("retry-mismatch", { ...fixture("retry-mismatch"), status: "failed" });
    await store("retry-mismatch", { version: 1, input: { kind: "hotspot-refresh", input: {} } }, true);
    await store("legacy-no-payload", { ...fixture("legacy-no-payload"), status: "queued", progress: 0 });
    await store("legacy-image-payload", { ...fixture("legacy-image-payload"), status: "queued", progress: 0 });
    await store("legacy-image-payload", { version: 1, input: { kind: "image-generation", input: imageInput } }, true);

    const { getJob, listJobSummaries, getJobReadErrors, retryJob } = await import("../src/lib/jobs");
    const jobs = await listJobSummaries();
    for (const indent of [0, 2, 4]) {
      const job = jobs.find((item) => item.id === `legacy-${indent}`)!;
      assert.ok(job);
      assert.equal("result" in job, false);
      assert.equal("partialText" in job, false);
      assert.equal(job.hasResult, true);
      assert.equal(job.hasPartialText, false);
      assert.equal(((await getJob(job.id)).result as { content: string }).content.length, 128 * 1024);
    }
    assert.equal(getJobReadErrors().length, 11);
    for (const id of ["future-version", "future-kind", "bad-ref", "bad-events", "wrong-id", "null-record", "broken", "trailing"]) {
      assert.equal(jobs.some((job) => job.id === id), false);
      await assert.rejects(getJob(id), /版本过新|结构无效|ID 与文件名不一致|JSON 文件损坏/);
    }
    for (const id of ["payload-future", "payload-invalid", "payload-mismatch"]) assert.equal((await getJob(id)).status, "queued");
    await assert.rejects(retryJob("retry-mismatch"), /类型不一致/);
    assert.equal((await getJob("legacy-no-payload")).status, "interrupted");
    assert.equal((await getJob("legacy-image-payload")).status, "interrupted", "图片任务不自动重跑收费");
    const updated = JSON.parse(await readFile(path.join(dir, "legacy-no-payload.json"), "utf8"));
    assert.equal(updated.schemaVersion, 1);
    for (const [target, raw] of originals) {
      if (["legacy-no-payload.json", "legacy-image-payload.json"].includes(path.basename(target)) && path.dirname(target) === dir) continue;
      assert.equal(await readFile(target, "utf8"), raw, `保留原文件 ${target}`);
    }
    await assert.rejects(getJob("../escape"), /不合法/);
  } finally {
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("任务版本和恢复输入保留旧字段、补默认值，并拒绝未来结构", () => {
  const legacy = { ...fixture("legacy"), extraLegacyField: "保留" };
  assert.equal(parseStoredRecord<typeof legacy>("legacy.json", legacy, "job").extraLegacyField, "保留");
  assert.throws(() => parseStoredRecord("future.json", { ...legacy, schemaVersion: 2 }, "job"), /版本过新/);
  const payload = parseStoredRecord<{ input: { input: { commentCount: number; includeComments: boolean } } }>("legacy-payload.json", {
    version: 1, input: { kind: "engagement", input: { sourceType: "text", text: "旧文稿" } }
  }, "job-payload");
  assert.equal(payload.input.input.commentCount, 50);
  assert.equal(payload.input.input.includeComments, true);
  assert.equal(startJobSchema.parse({ kind: "image-generation", title: "模型名称", input: imageInput }).title, "模型名称");
  assert.deepEqual(startJobSchema.options.map(schema => schema.shape.kind.value).sort(), jobKinds.filter(kind => kind !== "project-style" && kind !== "image-cover").sort());
  assert.deepEqual(jobKinds.map(defaultJobHref), ["/images", "/images", "/writer", "/writer", "/library", "/writer", "/library", "/library", "/assets", "/douyin-hotlist", "/library", "/tools", "/tools", "/hotspots", "/gross-margin/monitor"]);
});
