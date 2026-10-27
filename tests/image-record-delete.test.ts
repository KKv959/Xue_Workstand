import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { deleteImageRecords, getImageFile, getImageRecord, listImageRecords, saveImageFile, saveImageRecord } from "../src/lib/storage/images";
import { restoreLibraryTrashOperation } from "../src/lib/storage/transactions";

test("删除记录可恢复，保留原图与子记录的来源引用", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-record-delete-"));
  const env = { ...process.env };
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root });
  try {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const image = await saveImageFile(bytes, "原图");
    const record = { schemaVersion: 1, id: "parent", canvasId: "parent", model: "test", prompt: "test", size: "1024x1024", quality: "auto" as const, count: 1, referenceIds: [], images: [image], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await saveImageRecord(record);
    await saveImageRecord({ ...record, id: "child", parentRecordId: "parent", parentImageId: image.id, referenceIds: [image.id] });
    const result = await deleteImageRecords(["parent", "parent"]);
    assert.deepEqual(result.deleted, ["parent"]);
    assert.ok(result.trashOperationId);
    assert.deepEqual((await listImageRecords()).records.map((item) => item.id), ["child"]);
    assert.ok((await getImageRecord("parent"))?.deletedAt);
    assert.equal((await getImageRecord("child"))?.parentRecordId, "parent");
    assert.deepEqual((await getImageFile(image.id)).bytes, bytes);
    assert.deepEqual(await deleteImageRecords(["parent"]), { deleted: [] });
    await restoreLibraryTrashOperation(result.trashOperationId!);
    assert.equal((await listImageRecords()).total, 2);
    assert.equal((await getImageRecord("parent"))?.deletedAt, undefined);
    await assert.rejects(deleteImageRecords(["../bad"]), /不合法/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await fs.rm(root, { recursive: true, force: true });
  }
});
