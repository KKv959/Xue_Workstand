import path from "path";
import { AI_POLICIES, RETIRED_AI_POLICY_IDS, type AiSettings } from "../ai-policy-catalog";
import { libraryRoot } from "./core";
import { readJsonFile, writeJsonFile } from "./fs";
import { aiSettingsSchema } from "./schemas";
import { withMutationLock } from "./mutation-lock";

const globalQueues = globalThis as typeof globalThis & { aiSettingsQueues?: Map<string, Promise<unknown>> };
const queues = globalQueues.aiSettingsQueues ??= new Map();
export function validateAiSettings(value: unknown): AiSettings {
  const result = aiSettingsSchema.safeParse(value);
  if (!result.success) throw new Error(`AI 配置格式无效：${result.error.issues[0]?.message}`);
  for (const [id, config] of Object.entries(result.data.overrides)) {
    // 保留历史配置原值，但停用节点不再出现在设置页或参与请求。
    if (RETIRED_AI_POLICY_IDS.some((retired) => retired === id)) continue;
    const definition = AI_POLICIES.find((entry) => entry.id === id);
    if (!definition) throw new Error(`AI 配置包含未知链路：${id}`);
    if ("kind" in definition && config.effort !== "none") throw new Error("图片模型不支持对话推理等级");
    if (id === "web_research" && config.source && config.source !== "relay") throw new Error("联网检索只能使用中转链路");
    if (id === "image_generate" && config.source === "auto") throw new Error("图片生成请选择仅订阅或仅中转，不自动切换计费来源");
  }
  return result.data as AiSettings;
}
export async function readAiSettings(): Promise<AiSettings> {
  const value = await readJsonFile<unknown>(path.join(libraryRoot(), "settings", "ai-models.json"));
  return value === null ? { schemaVersion: 1, revision: 0, updatedAt: null, overrides: {} } : validateAiSettings(value);
}
export async function saveAiSettings(input: AiSettings) {
  const target = path.join(libraryRoot(), "settings", "ai-models.json");
  return withMutationLock(queues, target, async () => {
    const value = validateAiSettings(input);
    const current = await readAiSettings();
    if (value.revision !== current.revision) {
      throw Object.assign(new Error("配置已在其他页面更新，请重新载入后再修改。当前编辑内容已保留。"), { status: 409 });
    }
    const overrides = { ...value.overrides };
    for (const id of ["project_sample", "project_style", "image_cover"] as const) delete overrides[id];
    const next = { ...value, overrides, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    try { await writeJsonFile(target, next); }
    catch (error) { throw new Error(`保存 AI 配置失败，请检查资料目录的写入权限和可用空间。${error instanceof Error ? error.message : ""}`); }
    return next;
  });
}
