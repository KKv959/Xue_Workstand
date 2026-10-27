import { legacyProject } from "./helpers/legacy-project";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isResumableJobKind } from "../src/lib/job-persistence";
import { applyJobListResponse } from "../src/lib/job-sync";
import {
  deleteAccounts,
  resolveAccount,
  resolveProject,
  restoreLibraryTrashOperation,
  upsertAccount,
} from "../src/lib/storage";
import {
  resolveGrossMarginMonitorRecord,
  saveGrossMarginMonitorRecord,
  updateGrossMarginMonitorRecord,
  upsertGrossMarginMonitorRecord
} from "../src/lib/storage/gross-margin";
import { runRecoverableLibraryMutation } from "../src/lib/storage/transactions";
import type { JobListItem } from "../src/lib/types";

test("毛利监控记录并发更新不会丢字段，并拒绝旧 revision 覆盖", async () => {
  await withTemporaryLibrary(async () => {
    const created = await upsertGrossMarginMonitorRecord({
      platform: "bilibili",
      accountName: "并发测试账号",
      videoUrl: "https://www.bilibili.com/video/BV1test",
      videoKey: "BV1test",
      sourceText: "测试",
      targetStats: { play: 1000, like: 100 }
    });
    const stale = await resolveGrossMarginMonitorRecord(created.id);

    await Promise.all(Array.from({ length: 24 }, () =>
      updateGrossMarginMonitorRecord(created.id, (current) => ({
        ...current,
        targetStats: {
          ...current.targetStats,
          like: (current.targetStats.like || 0) + 1
        }
      }))
    ));

    const current = await resolveGrossMarginMonitorRecord(created.id);
    assert.equal(current.targetStats.like, 124);
    assert.equal(current.revision, (created.revision || 0) + 24);
    await assert.rejects(
      () => saveGrossMarginMonitorRecord({ ...stale, accountName: "旧数据覆盖" }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        return true;
      }
    );
  });
});

test("删除账号会原子清理引用，并可从回收站完整恢复", async () => {
  await withTemporaryLibrary(async () => {
    const account = await upsertAccount({ platform: "bilibili", name: "待恢复账号", uid: "recover-account" });
    const project = await legacyProject({ name: "引用项目", sourceAccountIds: [account.id] });
    const deleted = await deleteAccounts([account.id]);

    await assert.rejects(() => resolveAccount(account.platform, account.id), /找不到账号/);
    assert.deepEqual((await resolveProject(project.id)).sourceAccountIds, []);
    assert.ok(deleted.trashOperationId);

    const restored = await restoreLibraryTrashOperation(deleted.trashOperationId);
    assert.equal(restored.status, "restored");
    assert.equal((await resolveAccount(account.platform, account.id)).id, account.id);
    assert.deepEqual((await resolveProject(project.id)).sourceAccountIds, [account.id]);
  });
});

test("跨文件事务中途失败会自动回滚目标与关联文件", async () => {
  await withTemporaryLibrary(async (root) => {
    const target = path.join(root, "target.json");
    const reference = path.join(root, "reference.json");
    await fs.writeFile(target, JSON.stringify({ alive: true }));
    await fs.writeFile(reference, JSON.stringify({ target: "target.json" }));

    await assert.rejects(() => runRecoverableLibraryMutation({
      kind: "failure-injection",
      targets: [target],
      backupTargets: [reference],
      run: async () => {
        await fs.writeFile(reference, JSON.stringify({ target: null }));
        throw new Error("故障注入");
      }
    }), /故障注入/);

    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { alive: true });
    assert.deepEqual(JSON.parse(await fs.readFile(reference, "utf8")), { target: "target.json" });
  });
});

test("任务增量协议合并更新、移除和全量重置", () => {
  const first = jobItem("first", "2026-01-01T00:00:00.000Z", "running");
  const second = jobItem("second", "2026-01-02T00:00:00.000Z", "queued");
  const updatedFirst = { ...first, status: "completed" as const, updatedAt: "2026-01-03T00:00:00.000Z" };

  const incremental = applyJobListResponse([first, second], {
    jobs: [updatedFirst],
    removedJobIds: [second.id],
    cursor: "epoch.2",
    reset: false
  });
  assert.deepEqual(incremental.map((job) => [job.id, job.status]), [["first", "completed"]]);

  const reset = applyJobListResponse(incremental, {
    jobs: [second],
    removedJobIds: [],
    cursor: "new-epoch.0",
    reset: true
  });
  assert.deepEqual(reset.map((job) => job.id), ["second"]);
});

test("只有幂等安全的后台任务会在重启后自动恢复", () => {
  assert.equal(isResumableJobKind("gross-margin-refresh"), true);
  assert.equal(isResumableJobKind("batch-transcribe"), true);
  assert.equal(isResumableJobKind("write-copy"), false);
  assert.equal(isResumableJobKind("engagement"), false);
});

function jobItem(id: string, updatedAt: string, status: JobListItem["status"]): JobListItem {
  return {
    id,
    kind: "gross-margin-refresh",
    status,
    title: id,
    message: id,
    progress: 0,
    createdAt: updatedAt,
    updatedAt
  };
}

async function withTemporaryLibrary(run: (temporaryRoot: string) => Promise<void>) {
  const previousRoot = process.env.STYLE_LIBRARY_DIR;
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reliability-test-"));
  process.env.STYLE_LIBRARY_DIR = temporaryRoot;
  try {
    await run(temporaryRoot);
  } finally {
    if (previousRoot === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previousRoot;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
