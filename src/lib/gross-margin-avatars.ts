import { createHash } from "crypto";
import path from "path";
import { normalizeGrossMarginAccountName } from "./gross-margin-account-names";
import { getBilibiliVideoAuthorAvatarByUrl } from "./opencli-bilibili";
import { libraryRoot, normalizeStorageSegment } from "./storage/core";
import { fileExists, storageFs, writeFileAtomic } from "./storage/fs";
import { detectImageFormat } from "./storage/images";
import type { GrossMarginMonitorRecord } from "./types";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const inFlight = new Map<string, Promise<Buffer>>();
const waiting: Array<() => void> = [];
let active = 0;

// Optional binary caches do not change monitor records or their revisions.
// Normalized aliases share one file; a missing cache is populated lazily once.
export async function getGrossMarginMonitorAvatar(record: GrossMarginMonitorRecord, signal?: AbortSignal) {
  if (record.platform !== "bilibili") throw Object.assign(new Error("此账号不支持 B站头像。"), { status: 400 });
  const name = normalizeGrossMarginAccountName(record.accountName) || record.videoKey;
  const key = normalizeStorageSegment(createHash("sha256").update(`bilibili:${name}`).digest("hex"), "头像缓存 ID");
  const target = path.join(libraryRoot(), "gross-margin", "avatar-cache", `${key}.image`);
  try {
    let bytes: Buffer;
    if (await fileExists(target)) {
      bytes = await storageFs.readFileBytes(target);
    } else {
      let pending = inFlight.get(target);
      if (!pending) {
        pending = downloadAndCache(record.videoUrl, target, signal);
        inFlight.set(target, pending);
      }
      try { bytes = await pending; }
      finally { if (inFlight.get(target) === pending) inFlight.delete(target); }
    }
    return { bytes, contentType: `image/${detectImageFormat(bytes)}` };
  } catch (error) {
    throw new Error(`加载账号头像失败，请刷新页面重试。${error instanceof Error ? error.message : "请检查网络和素材库目录权限。"}`);
  }
}

async function downloadAndCache(videoUrl: string, target: string, signal?: AbortSignal) {
  if (active < 4) active += 1;
  else await new Promise<void>(resolve => waiting.push(resolve));
  try {
    const timeout = AbortSignal.timeout(15_000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    fetchSignal.throwIfAborted();
    const source = new URL(await getBilibiliVideoAuthorAvatarByUrl(videoUrl, fetchSignal));
    // Only B站's image CDN is allowed; redirects cannot turn this into a generic proxy.
    if (source.protocol !== "https:" || !/(^|\.)hdslb\.com$/.test(source.hostname) || source.port || source.username || source.password) {
      throw new Error("B站返回了不受支持的头像地址。");
    }
    const response = await fetch(source, {
      signal: fetchSignal, redirect: "error",
      headers: { "User-Agent": "Mozilla/5.0 style-library", Referer: "https://www.bilibili.com/" }
    });
    if (!response.ok || !response.body) throw new Error(`头像下载失败（HTTP ${response.status}）。`);
    if (Number(response.headers.get("content-length")) > MAX_AVATAR_BYTES) {
      await response.body.cancel();
      throw new Error("头像图片超过 2MB，请检查头像来源。");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_AVATAR_BYTES) throw new Error("头像图片超过 2MB，请检查头像来源。");
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    detectImageFormat(bytes);
    await writeFileAtomic(target, bytes);
    return bytes;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}
