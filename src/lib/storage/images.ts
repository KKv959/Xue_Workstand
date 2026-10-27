import { runRecoverableLibraryMutation } from "./transactions";
import path from "path";
import { randomUUID } from "crypto";
import { libraryRoot, normalizeStorageSegment } from "./core";
import { readJsonFile, storageFs, writeFileAtomic, writeJsonFile } from "./fs";
import { parseStoredRecord, STORAGE_SCHEMA_VERSION } from "./schemas";
import type { ImageFile, ImageGenerationRecord, ImageGenerationSummary } from "../image-generation-types";
import { imagePromptLabel } from "../image-mentions";
import { mapWithConcurrency } from "../concurrency";

function recordPath(id: string) {
  return path.join(libraryRoot(), "images", "records", `${normalizeStorageSegment(id, "生图记录 ID")}.json`);
}
function filePath(id: string, extension: string) {
  return path.join(libraryRoot(), "images", "files", `${normalizeStorageSegment(id, "图片 ID")}.${extension}`);
}
export function detectImageFormat(bytes: Buffer): ImageFile["format"] {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw Object.assign(new Error("图片内容无效，仅支持 PNG、JPEG 或 WebP。"), { statusCode: 400 });
}
export async function saveImageFile(bytes: Buffer, name: string): Promise<ImageFile> {
  if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw new Error("图片为空或超过 40MB，请缩小后重试。");
  const image: ImageFile = { id: randomUUID(), name: name.slice(0, 160), format: detectImageFormat(bytes), createdAt: new Date().toISOString() };
  try {
    await writeFileAtomic(filePath(image.id, image.format), bytes);
    await writeJsonFile(filePath(image.id, "json"), { ...image, schemaVersion: STORAGE_SCHEMA_VERSION });
  } catch { throw new Error("保存图片失败，请检查素材库目录权限和磁盘空间。"); }
  return image;
}
export async function getImageMetadata(id: string) {
  const target = filePath(id, "json");
  const raw = await readJsonFile<unknown>(target);
  if (!raw) throw Object.assign(new Error("找不到图片，请重新上传或刷新记录。"), { statusCode: 404 });
  const image = parseStoredRecord<ImageFile>(target, raw, "image-file");
  if (image.id !== id) throw new Error("图片记录 ID 不一致，请检查素材库。");
  return image;
}
export async function getImageFile(id: string) {
  const image = await getImageMetadata(id);
  let bytes: Buffer;
  try { bytes = await storageFs.readFileBytes(filePath(id, image.format)); }
  catch { throw new Error("读取图片文件失败，请检查素材库文件是否完整。" ); }
  return { image, bytes, contentType: `image/${image.format}` };
}
export async function getImageRecord(id: string): Promise<ImageGenerationRecord | null> {
  const target = recordPath(id);
  const raw = await readJsonFile<unknown>(target);
  if (!raw) return null;
  const record = parseStoredRecord<ImageGenerationRecord>(target, raw, "image-generation");
  if (record.id !== id) throw new Error("生图记录 ID 不一致，请检查素材库。");
  return record;
}
// Records are immutable to other callers: only their owning job appends images, sequentially.
export async function saveImageRecord(record: ImageGenerationRecord) {
  const target = recordPath(record.id);
  const valid = parseStoredRecord<ImageGenerationRecord>(target, record, "image-generation");
  try { await writeJsonFile(target, valid); }
  catch { throw new Error("保存生图记录失败，请检查素材库目录权限和磁盘空间。"); }
}
export async function listImageRecords(offset = 0, limit = 40, canvasId?: string) {
  let entries: string[];
  try { entries = await storageFs.readdir(path.join(libraryRoot(), "images", "records")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { records: [], total: 0 };
    throw new Error("读取生图历史失败，请检查素材库目录权限。");
  }
  // Bounded reads avoid opening every historical asset concurrently; image bytes stay lazy.
  const summaries = await mapWithConcurrency(entries.filter((name) => name.endsWith(".json")), 6, async (entry): Promise<ImageGenerationSummary | null> => {
    const record = await getImageRecord(entry.slice(0, -5));
    if (!record || record.deletedAt || (canvasId && (record.canvasId || record.id) !== canvasId)) return null;
    return { id: record.id, canvasId: record.canvasId || record.id, parentRecordId: record.parentRecordId, parentImageId: record.parentImageId, referenceIds: record.referenceIds, model: record.model, size: record.size, count: record.count, createdAt: record.createdAt, updatedAt: record.updatedAt, title: imagePromptLabel(record.prompt).slice(0, 60), imageCount: record.images.length, thumbnail: record.images[0] };
  });
  const records = summaries.filter((record): record is ImageGenerationSummary => record !== null);
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { records: records.slice(offset, offset + limit), total: records.length };
}

// Keep the original record and image files available to descendant references.
// The shared transaction keeps backups so this removal can be undone.
export async function deleteImageRecords(ids: string[]) {
  const records: ImageGenerationRecord[] = [];
  for (const id of new Set(ids)) {
    const record = await getImageRecord(id);
    if (record && !record.deletedAt) records.push(record);
  }
  if (!records.length) return { deleted: [] as string[] };
  const transaction = await runRecoverableLibraryMutation({
    kind: "delete-image-records", targets: [], backupTargets: records.map((record) => recordPath(record.id)),
    run: async () => {
      for (const record of records) await saveImageRecord({ ...record, deletedAt: new Date().toISOString() });
      return records.map((record) => record.id);
    }
  });
  return { deleted: transaction.result, trashOperationId: transaction.operation.id };
}
