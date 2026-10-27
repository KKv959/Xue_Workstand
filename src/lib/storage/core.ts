import path from "path";
import { safeSegment } from "../utils";

export function libraryRoot() {
  return path.resolve(process.cwd(), process.env.STYLE_LIBRARY_DIR || "style-library");
}

export function normalizeStorageSegment(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized.includes("..") || normalized !== safeSegment(normalized)) {
    throw Object.assign(new Error(`${label} 不合法`), { status: 400 });
  }
  return normalized;
}

export function toLibraryRelativePath(target: string) {
  const relative = path.relative(libraryRoot(), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径不在素材库内：${target}`);
  }
  return relative.split(path.sep).join("/");
}

export function resolveStoredLibraryPath(storedPath: string) {
  if (path.isAbsolute(storedPath)) return path.normalize(storedPath);
  const normalized = storedPath.split("/").join(path.sep);
  const target = path.resolve(libraryRoot(), normalized);
  const relative = path.relative(libraryRoot(), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`素材库相对路径不合法：${storedPath}`);
  }
  return target;
}
