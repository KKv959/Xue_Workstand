import path from "node:path";
import { randomUUID } from "node:crypto";
import { libraryRoot, normalizeStorageSegment } from "../../src/lib/storage/core";
import { writeJsonFile, writeTextFileAtomic } from "../../src/lib/storage/fs";
import type { Project } from "../../src/lib/types";

export async function legacyProject(input: { name: string; sourceAccountIds?: string[] }) {
  const slug = normalizeStorageSegment(`legacy-${randomUUID()}`, "历史项目目录");
  const time = new Date().toISOString();
  const project: Project = { id: `project:${slug}`, slug, name: input.name,
    sourceAccountIds: input.sourceAccountIds || [], sourceMaterialIds: [], createdAt: time, updatedAt: time };
  const root = path.join(libraryRoot(), "projects", slug);
  await writeJsonFile(path.join(root, "project.json"), { schemaVersion: 1, ...project });
  await writeTextFileAtomic(path.join(root, "style.md"), "历史项目风格卡");
  return project;
}
