import { createHash } from "crypto";
import path from "path";
import { libraryRoot, normalizeStorageSegment } from "./core";
import { readJsonFile, writeJsonFile } from "./fs";
import { parseStoredRecord, versionStoredRecord } from "./schemas";

export type SupportDocumentCacheRecord = {
  schemaVersion?: number;
  cacheKey: string;
  url: string;
  provider: "feishu" | "lingxi" | "wecom" | "tencent-docs" | "web";
  title?: string;
  content: string;
  fetchedAt: string;
};

const SUPPORT_DOCUMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function readSupportDocumentCache(url: string) {
  const normalizedUrl = normalizeSupportDocumentCacheUrl(url);
  const cacheKey = supportDocumentCacheKey(normalizedUrl);
  const target = supportDocumentCacheJsonPath(cacheKey);
  const value = await readJsonFile<unknown>(target);
  if (value === null) return null;

  const record = parseStoredRecord<SupportDocumentCacheRecord>(target, value, "support-document-cache");
  if (record.cacheKey !== cacheKey || normalizeSupportDocumentCacheUrl(record.url) !== normalizedUrl) {
    throw new Error(`支持文档缓存键不匹配：${target}`);
  }
  const fetchedAt = Date.parse(record.fetchedAt);
  if (!Number.isFinite(fetchedAt)) throw new Error(`支持文档缓存时间无效：${target}`);
  if (Date.now() - fetchedAt >= SUPPORT_DOCUMENT_CACHE_TTL_MS) return null;
  return record;
}

export async function writeSupportDocumentCache(
  record: Omit<SupportDocumentCacheRecord, "schemaVersion" | "cacheKey" | "url" | "fetchedAt"> & {
    url: string;
    fetchedAt?: string;
  }
) {
  const normalizedUrl = normalizeSupportDocumentCacheUrl(record.url);
  const cacheKey = supportDocumentCacheKey(normalizedUrl);
  const target = supportDocumentCacheJsonPath(cacheKey);
  const versioned = versionStoredRecord({
    ...record,
    cacheKey,
    url: normalizedUrl,
    content: record.content.trim(),
    fetchedAt: record.fetchedAt || new Date().toISOString()
  });
  const parsed = parseStoredRecord<SupportDocumentCacheRecord>(target, versioned, "support-document-cache");
  await writeJsonFile(target, parsed);
  return parsed;
}

export function supportDocumentCacheKey(url: string) {
  return createHash("sha256").update(normalizeSupportDocumentCacheUrl(url)).digest("hex");
}

function supportDocumentCacheJsonPath(cacheKey: string) {
  return path.join(
    libraryRoot(),
    ".cache",
    "support-documents",
    `${normalizeStorageSegment(cacheKey, "支持文档缓存键")}.json`
  );
}

function normalizeSupportDocumentCacheUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("支持文档缓存引用不能为空");

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("支持文档缓存只接受 HTTP/HTTPS 链接或飞书文档标识");
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && /支持文档缓存只接受/.test(error.message)) throw error;
    if (/\s/.test(trimmed)) throw new Error("支持文档缓存引用格式无效");
    return trimmed;
  }
}
