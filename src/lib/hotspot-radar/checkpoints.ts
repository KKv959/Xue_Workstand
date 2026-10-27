import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { libraryRoot, normalizeStorageSegment } from "../storage/core";
import { readJsonFile, writeJsonFile } from "../storage/fs";
import { withMutationLock } from "../storage/mutation-lock";
import { hotspotCheckpointSchema } from "../storage/schemas";
import { getConfiguredChatConfigs } from "../model-runtime";

const locks = new Map<string, Promise<unknown>>();
export function radarCheckpointKey(system: string, payload: unknown) {
  // Only a digest is persisted; credentials and endpoint configuration never enter the record.
  const targets = getConfiguredChatConfigs().map(({ apiKey: _apiKey, ...config }) => { void _apiKey; return config; });
  return createHash("sha256").update(JSON.stringify({ version: 4, system, payload, targets, reasoning: "service-default", output: 3500 })).digest("hex");
}
function target(key: string) { return path.join(libraryRoot(), ".cache", "hotspot-analysis", `${normalizeStorageSegment(key, "热点分析缓存键")}.json`); }
export async function readRadarCheckpoint<T>(key: string, schema: z.ZodType<T>) {
  const raw = await readJsonFile<unknown>(target(key));
  if (raw === null) return null;
  const parsed = hotspotCheckpointSchema.safeParse(raw);
  if (!parsed.success || parsed.data.key !== key) throw new Error("热点分析缓存损坏，请检查 .cache/hotspot-analysis；未覆盖文件");
  if (Date.now() - Date.parse(parsed.data.createdAt) > 72 * 3600000) return null;
  const result = schema.safeParse(parsed.data.result);
  if (!result.success) throw new Error("热点分析缓存内容格式损坏，请检查缓存记录");
  return { result: result.data, fallbackReason: parsed.data.fallbackReason };
}
export async function writeRadarCheckpoint(key: string, result: unknown, fallbackReason?: string) {
  return withMutationLock(locks, target(key), () => writeJsonFile(target(key), hotspotCheckpointSchema.parse({ schemaVersion: 1, key, createdAt: new Date().toISOString(), result, fallbackReason })));
}
