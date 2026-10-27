import path from "node:path";
import { z } from "zod";
import { libraryRoot } from "../storage/core";
import { readJsonFile, writeJsonFile } from "../storage/fs";
import { withMutationLock } from "../storage/mutation-lock";
import { hotspotCollectionSchema } from "../storage/schemas";

export type RadarCollection = z.infer<typeof hotspotCollectionSchema>;
const queues = new Map<string, Promise<unknown>>();
function collectionPath() { return path.join(libraryRoot(), "hotspots", "radar-collection.json"); }
export async function readRadarCollection() {
  const value = await readJsonFile<unknown>(collectionPath());
  if (value === null) return null;
  const parsed = hotspotCollectionSchema.safeParse(value);
  if (!parsed.success) throw new Error("热点采集记录格式损坏，请检查 hotspots/radar-collection.json；未覆盖文件");
  return parsed.data;
}
export function writeRadarCollection(value: RadarCollection) {
  return withMutationLock(queues, collectionPath(), () => writeJsonFile(collectionPath(), hotspotCollectionSchema.parse(value)));
}
export function updateRadarCollection(update: (current: RadarCollection) => RadarCollection) {
  return withMutationLock(queues, collectionPath(), async () => {
    const current = await readRadarCollection();
    if (!current) throw new Error("本轮采集记录缺失，请重新采集");
    await writeJsonFile(collectionPath(), hotspotCollectionSchema.parse(update(current)));
  });
}
