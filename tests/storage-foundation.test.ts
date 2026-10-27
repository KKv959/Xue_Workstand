import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactJobForPersistence } from "../src/lib/job-persistence";
import { getDraftSummaries, resolveDraft, saveDraft, saveTranscript, saveVideos, upsertAccount } from "../src/lib/storage";
import { parseStoredRecord, STORAGE_SCHEMA_VERSION } from "../src/lib/storage/schemas";
import type { Account, JobRecord, Video } from "../src/lib/types";

test("核心记录新写入带版本号且转写路径可迁移", async () => {
  await withTemporaryLibrary(async (temporaryRoot) => {
    const account = await upsertAccount({ platform: "bilibili", name: "路径测试", uid: "portable-path" });
    await saveVideos(account, [videoFixture(account)]);
    await saveTranscript({
      platform: account.platform,
      accountId: account.id,
      videoId: "video-1",
      text: "可迁移路径测试",
      source: "manual"
    });

    const accountRaw = JSON.parse(await fs.readFile(path.join(temporaryRoot, "bilibili", account.slug, "account.json"), "utf8"));
    const videoRaw = JSON.parse(await fs.readFile(path.join(temporaryRoot, "bilibili", account.slug, "videos", "video-1.json"), "utf8"));

    assert.equal(accountRaw.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(videoRaw.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(path.isAbsolute(videoRaw.transcriptPath), false);
    assert.equal(videoRaw.transcriptPath, `bilibili/${account.slug}/transcripts/video-1.txt`);
  });
});

test("存储校验兼容无版本旧记录并拒绝未来版本", () => {
  const legacy = accountFixture();
  assert.equal(parseStoredRecord<Account>("legacy/account.json", legacy, "account").id, legacy.id);
  assert.throws(
    () => parseStoredRecord<Account>("future/account.json", {
      ...legacy,
      schemaVersion: STORAGE_SCHEMA_VERSION + 1
    }, "account"),
    /版本过新/
  );
  assert.throws(
    () => parseStoredRecord<Account>("broken/account.json", { ...legacy, name: 42 }, "account"),
    /结构无效/
  );
});

test("同一毫秒相同正文的并发保存保留独立ID和版本", async (t) => {
  await withTemporaryLibrary(async () => {
    const first = await upsertAccount({ platform: "douyin", name: "保存一", uid: "save-one" });
    const second = await upsertAccount({ platform: "douyin", name: "保存二", uid: "save-two" });
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const drafts = await Promise.all([first, first, second].map((account, index) => saveDraft({
      platform: account.platform, accountId: account.id, accountName: account.name,
      title: "并发测试", mode: "topic", prompt: "测试", content: "相同正文",
      styleRef: { platform: account.platform, accountId: account.id, accountName: account.name },
      version: { sessionId: `session-${index}`, revision: 1, origin: "generated", contextFingerprint: "test", promptVersion: "test" }
    })));
    assert.equal(new Set(drafts.map(draft => draft.createdAt)).size, 1);
    assert.equal(new Set(drafts.map(draft => draft.id)).size, 3);
    assert.equal((await getDraftSummaries()).length, 3);
    for (const draft of drafts) assert.equal((await resolveDraft(draft.id)).draft.version?.sessionId, draft.version?.sessionId);
  });
});

test("已结束任务只压缩过大的磁盘结果", () => {
  const job = jobFixture({ result: { draft: { id: "saved-draft" }, content: "x".repeat(4096) } });
  const compacted = compactJobForPersistence(job, 512);

  assert.equal(compacted.result, undefined);
  assert.equal(compacted.resultCompacted, true);
  assert.ok((compacted.resultSizeBytes || 0) > 512);
  assert.equal(job.result !== undefined, true);

  const running = compactJobForPersistence({ ...job, status: "running" }, 512);
  assert.deepEqual(running.result, job.result);
});

function accountFixture(): Account {
  const now = new Date().toISOString();
  return {
    id: "bilibili:legacy",
    slug: "legacy",
    platform: "bilibili",
    name: "旧账号",
    uid: "legacy",
    createdAt: now,
    updatedAt: now
  };
}

function videoFixture(account: Account): Video {
  return {
    id: "video-1",
    platform: account.platform,
    accountId: account.id,
    title: "测试视频",
    url: "https://www.bilibili.com/video/BV1test",
    stats: { views: 100, likes: 10, comments: 2, favorites: 1, shares: 0 },
    hotScore: 0,
    relativeViewRate: 1,
    transcriptStatus: "not_started",
    updatedAt: new Date().toISOString()
  };
}

function jobFixture(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: "job-test",
    kind: "write-copy",
    status: "completed",
    title: "测试任务",
    message: "完成",
    progress: 100,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides
  };
}

async function withTemporaryLibrary(run: (temporaryRoot: string) => Promise<void>) {
  const previousRoot = process.env.STYLE_LIBRARY_DIR;
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "storage-foundation-test-"));
  process.env.STYLE_LIBRARY_DIR = temporaryRoot;
  try {
    await run(temporaryRoot);
  } finally {
    if (previousRoot === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previousRoot;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
