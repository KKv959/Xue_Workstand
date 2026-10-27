import { createHash } from "node:crypto";
import path from "node:path";
import { libraryRoot, normalizeStorageSegment } from "./core";
import { readJsonFile, writeJsonFile } from "./fs";
import { withMutationLock } from "./mutation-lock";
import { writerResearchCacheSchema } from "./schemas";

export const WRITER_RESEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
const locks = new Map<string, Promise<unknown>>();

export class WriterResearchCacheError extends Error {}

// 指纹由真实检索输入及配置构成，不包含风格卡或密钥。
export async function cachedWriterResearch(
  fingerprint: string,
  fetcher: () => Promise<{ content: string; cacheable: boolean }>,
  options: { signal?: AbortSignal; onProgress?: (message: string) => void; onCacheHit?: () => void; now?: () => number } = {}
): Promise<string> {
  const cacheKey = createHash("sha256").update(fingerprint).digest("hex");
  const target = path.join(libraryRoot(), ".cache", "writer-research", `${normalizeStorageSegment(cacheKey, "联网检索缓存键")}.json`);
  const now = options.now ?? Date.now;
  options.signal?.throwIfAborted();
  if (locks.has(target)) options.onProgress?.("正在等待相同资料的联网检索结果");
  const pending = withMutationLock(locks, target, async () => {
    options.signal?.throwIfAborted();
    const raw = await readJsonFile<unknown>(target).catch((cause) => {
      throw new WriterResearchCacheError("联网检索缓存读取失败，请检查 .cache/writer-research 的文件内容及读取权限；未覆盖缓存", { cause });
    });
    const parsed = raw === null ? null : writerResearchCacheSchema.safeParse(raw);
    if (parsed && (!parsed.success || parsed.data.cacheKey !== cacheKey)) {
      throw new WriterResearchCacheError("联网检索缓存损坏，请检查 .cache/writer-research 中的对应文件；未覆盖缓存");
    }
    const saved = parsed?.success ? parsed.data : undefined;
    const age = saved ? now() - saved.fetchedAt : -1;
    options.signal?.throwIfAborted();
    if (saved && age >= 0 && age < WRITER_RESEARCH_CACHE_TTL_MS) {
      options.onCacheHit?.();
      options.onProgress?.("已复用联网检索缓存（30 分钟内），正在整理资料");
      return saved.content;
    }
    options.onProgress?.("正在联网检索资料");
    const result = await fetcher();
    options.signal?.throwIfAborted();
    if (result.cacheable && result.content.trim()) {
      const record = writerResearchCacheSchema.parse({ schemaVersion: 1, cacheKey, fetchedAt: now(), content: result.content });
      await writeJsonFile(target, record).catch((cause) => {
        throw new WriterResearchCacheError("联网检索缓存保存失败，请检查磁盘空间及 .cache/writer-research 的写入权限", { cause });
      });
    }
    return result.content;
  });
  // 等锁时也立即响应取消；排队回调拿到锁后再次检查信号，不会发起检索。
  const signal = options.signal;
  if (!signal) return pending;
  return new Promise<string>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("联网检索已取消"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
