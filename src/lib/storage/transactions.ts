import { createHash, randomUUID } from "crypto";
import path from "path";
import { libraryRoot, normalizeStorageSegment, toLibraryRelativePath } from "./core";
import { fileExists, readJsonFile, storageFs as fs, writeFileAtomic, writeJsonFile } from "./fs";
import type { LibraryTrashOperation } from "../types";

type RecoverableLibraryMutationOptions<T> = {
  kind: string;
  targets: string[];
  backupTargets?: string[];
  run: () => Promise<T>;
};

const globalTransactions = globalThis as typeof globalThis & {
  __styleWorkbenchLibraryTransactionQueue?: Promise<unknown>;
};

function trashRoot() {
  return path.join(libraryRoot(), ".trash");
}

function operationPath(operationId: string) {
  return path.join(trashRoot(), normalizeStorageSegment(operationId, "回收站操作 ID"));
}

function manifestPath(operationId: string) {
  return path.join(operationPath(operationId), "manifest.json");
}

export async function runRecoverableLibraryMutation<T>(
  options: RecoverableLibraryMutationOptions<T>
): Promise<{ result: T; operation: LibraryTrashOperation }> {
  return enqueueLibraryTransaction(() => runRecoverableLibraryMutationUnlocked(options));
}

export async function listLibraryTrashOperations() {
  await fs.mkdir(trashRoot(), { recursive: true });
  const entries = await fs.readdirEntries(trashRoot()).catch(() => []);
  const operations = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJsonFile<LibraryTrashOperation>(manifestPath(entry.name)))
  );
  return operations
    .filter((operation): operation is LibraryTrashOperation => Boolean(operation))
    .sort((left, right) => +new Date(right.createdAt) - +new Date(left.createdAt));
}

export async function restoreLibraryTrashOperation(operationId: string) {
  return enqueueLibraryTransaction(async () => {
    const id = normalizeStorageSegment(operationId, "回收站操作 ID");
    const manifest = await readJsonFile<LibraryTrashOperation>(manifestPath(id));
    if (!manifest) throw new Error(`找不到回收站操作：${id}`);
    if (manifest.status === "restored") return manifest;
    if (manifest.status === "rolled_back") throw new Error("该删除操作已自动回滚，无需再次恢复。");
    if (manifest.status !== "committed" && manifest.status !== "prepared" && manifest.status !== "rollback_failed") {
      throw new Error(`当前回收站操作状态不可恢复：${manifest.status}`);
    }

    await assertRestoreHasNoConflicts(id, manifest);
    await restoreOperationFiles(id, manifest);
    const restored: LibraryTrashOperation = {
      ...manifest,
      status: "restored",
      restoredAt: new Date().toISOString(),
      error: undefined
    };
    await writeJsonFile(manifestPath(id), restored);
    return restored;
  });
}

async function runRecoverableLibraryMutationUnlocked<T>(
  options: RecoverableLibraryMutationOptions<T>
): Promise<{ result: T; operation: LibraryTrashOperation }> {
  const id = createOperationId(options.kind);
  const base = operationPath(id);
  const targets = await resolveMutationTargets(options.targets);
  const backups = await createMutationBackups(base, options.backupTargets || [], targets.map((target) => target.absolutePath));
  let manifest: LibraryTrashOperation = {
    version: 1,
    id,
    kind: options.kind,
    status: "prepared",
    targets: targets.map(({ relativePath, kind }) => ({ path: relativePath, kind })),
    backups,
    createdAt: new Date().toISOString()
  };

  await fs.mkdir(base, { recursive: true });
  await writeJsonFile(manifestPath(id), manifest);

  try {
    for (const target of targets) {
      const destination = path.join(base, "payload", fromLibraryPath(target.relativePath));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(target.absolutePath, destination);
    }

    const result = await options.run();
    const committedAt = new Date().toISOString();
    manifest = {
      ...manifest,
      status: "committed",
      backups: await attachPostMutationHashes(manifest.backups),
      completedAt: committedAt
    };
    await writeJsonFile(manifestPath(id), manifest);
    return { result, operation: manifest };
  } catch (error) {
    try {
      await restoreOperationFiles(id, manifest);
      manifest = {
        ...manifest,
        status: "rolled_back",
        completedAt: new Date().toISOString(),
        error: describeError(error)
      };
      await writeJsonFile(manifestPath(id), manifest);
    } catch (rollbackError) {
      manifest = {
        ...manifest,
        status: "rollback_failed",
        completedAt: new Date().toISOString(),
        error: `${describeError(error)}；自动回滚失败：${describeError(rollbackError)}`
      };
      await writeJsonFile(manifestPath(id), manifest).catch(() => undefined);
      throw new Error(manifest.error);
    }
    throw error;
  }
}

async function resolveMutationTargets(targets: string[]) {
  const unique = uniqueLibraryTargets(targets);
  const resolved: Array<{ absolutePath: string; relativePath: string; kind: "file" | "directory" }> = [];
  for (const absolutePath of unique) {
    const stat = await fs.lstat(absolutePath).catch((error) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (!stat) continue;
    resolved.push({
      absolutePath,
      relativePath: assertMutableLibraryPath(absolutePath),
      kind: stat.isDirectory() ? "directory" : "file"
    });
  }
  return resolved;
}

async function createMutationBackups(base: string, backupTargets: string[], movedTargets: string[]) {
  const backups: LibraryTrashOperation["backups"] = [];
  for (const absolutePath of uniqueLibraryTargets(backupTargets)) {
    if (movedTargets.some((target) => isSameOrDescendant(absolutePath, target))) continue;
    const stat = await fs.stat(absolutePath).catch((error) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (!stat?.isFile()) continue;
    const relativePath = assertMutableLibraryPath(absolutePath);
    const bytes = await fs.readFileBytes(absolutePath);
    const backup = path.join(base, "backups", fromLibraryPath(relativePath));
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await writeFileAtomic(backup, bytes);
    backups.push({ path: relativePath, beforeHash: hashBytes(bytes) });
  }
  return backups;
}

async function attachPostMutationHashes(backups: LibraryTrashOperation["backups"]) {
  return Promise.all(
    backups.map(async (backup) => ({
      ...backup,
      afterHash: await hashFileIfExists(path.join(libraryRoot(), fromLibraryPath(backup.path)))
    }))
  );
}

async function assertRestoreHasNoConflicts(operationId: string, manifest: LibraryTrashOperation) {
  for (const target of manifest.targets) {
    const destination = path.join(libraryRoot(), fromLibraryPath(target.path));
    if (await fileExists(destination)) {
      throw createConflictError(`恢复失败：目标路径已存在：${target.path}`);
    }
    const payload = path.join(operationPath(operationId), "payload", fromLibraryPath(target.path));
    if (!(await fileExists(payload))) {
      throw new Error(`回收站内容缺失，无法恢复：${target.path}`);
    }
  }

  if (manifest.status !== "committed") return;
  for (const backup of manifest.backups) {
    const currentHash = await hashFileIfExists(path.join(libraryRoot(), fromLibraryPath(backup.path)));
    if (currentHash !== (backup.afterHash ?? null)) {
      throw createConflictError(`恢复失败：关联文件在删除后又被修改：${backup.path}`);
    }
  }
}

async function restoreOperationFiles(operationId: string, manifest: LibraryTrashOperation) {
  const base = operationPath(operationId);
  for (const backup of manifest.backups) {
    const source = path.join(base, "backups", fromLibraryPath(backup.path));
    if (!(await fileExists(source))) continue;
    await writeFileAtomic(path.join(libraryRoot(), fromLibraryPath(backup.path)), await fs.readFileBytes(source));
  }

  for (const target of [...manifest.targets].reverse()) {
    const source = path.join(base, "payload", fromLibraryPath(target.path));
    if (!(await fileExists(source))) continue;
    const destination = path.join(libraryRoot(), fromLibraryPath(target.path));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }
}

function uniqueLibraryTargets(targets: string[]) {
  const unique = [...new Set(targets.filter(Boolean).map((target) => path.resolve(target)))]
    .map((target) => ({ target, relative: assertMutableLibraryPath(target) }))
    .sort((left, right) => left.target.length - right.target.length);
  return unique
    .filter((candidate, index) => !unique.slice(0, index).some((parent) => isSameOrDescendant(candidate.target, parent.target)))
    .map((candidate) => candidate.target);
}

function assertMutableLibraryPath(target: string) {
  const relative = toLibraryRelativePath(target);
  if (relative === ".trash" || relative.startsWith(".trash/")) {
    throw new Error("拒绝把回收站自身作为素材库事务目标。");
  }
  return relative;
}

function isSameOrDescendant(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createOperationId(kind: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeKind = normalizeStorageSegment(kind, "素材库事务类型");
  return `${timestamp}-${safeKind}-${randomUUID().slice(0, 8)}`;
}

function fromLibraryPath(relativePath: string) {
  return relativePath.split("/").join(path.sep);
}

async function hashFileIfExists(target: string) {
  try {
    return hashBytes(await fs.readFileBytes(target));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createConflictError(message: string) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

function describeError(error: unknown) {
  return error instanceof Error && error.message ? error.message : "素材库事务失败";
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function enqueueLibraryTransaction<T>(run: () => Promise<T>) {
  const previous = globalTransactions.__styleWorkbenchLibraryTransactionQueue ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  globalTransactions.__styleWorkbenchLibraryTransactionQueue = next;
  try {
    return await next;
  } finally {
    if (globalTransactions.__styleWorkbenchLibraryTransactionQueue === next) {
      globalTransactions.__styleWorkbenchLibraryTransactionQueue = Promise.resolve();
    }
  }
}
