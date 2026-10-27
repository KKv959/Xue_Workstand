import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { z } from "zod";
import { chatCompleteStrict } from "./ai";
import { libraryRoot } from "./storage/core";
import { readJsonFile, writeJsonFile } from "./storage/fs";
import { trendRadarNativeStateSchema } from "./storage/schemas";
import { trendRadarRunner } from "./trendradar-native-runner";
import { trendRadarSettingsSchema, type TrendRadarSettings, type TrendRadarReport, type TrendRadarNativeStatus } from "./trendradar-native-types";

const active = new Set<string>();
function statePath() { return path.join(libraryRoot(), "hotspots", "trendradar-native.json"); }
async function readState() {
  const raw = await readJsonFile<unknown>(statePath());
  if (raw === null) return null;
  const parsed = trendRadarNativeStateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("TrendRadar 报告记录损坏，请检查 hotspots/trendradar-native.json；未覆盖原文件");
  return parsed.data;
}
function publicReport(state: z.infer<typeof trendRadarNativeStateSchema>): TrendRadarReport {
  const { html: _html, databases: _databases, ...report } = state;
  void _html; void _databases;
  return report;
}
export async function getTrendRadarNativeStatus(): Promise<TrendRadarNativeStatus> {
  const state = await readState();
  return { report: state ? publicReport(state) : null, defaults: state?.settings || trendRadarSettingsSchema.parse({}) };
}
export async function getTrendRadarNativeHtml() {
  const state = await readState();
  if (!state) throw new Error("尚无 TrendRadar 报告，请先生成报告");
  return state.html;
}
const modelMessage = z.object({
  type: z.literal("model"), messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).min(1),
  maxTokens: z.number().int().positive().max(32000),
});
type Progress = { stage: string; message: string; progress: number };

export async function runTrendRadarNative(settings: TrendRadarSettings, options: {
  signal?: AbortSignal; onProgress?: (progress: Progress) => Promise<void>;
} = {}): Promise<TrendRadarReport> {
  settings = trendRadarSettingsSchema.parse(settings);
  const key = statePath();
  if (active.has(key)) throw new Error("TrendRadar 报告任务正在运行，请在任务中心查看进度");
  active.add(key);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15 * 60 * 1000)]);
  const container = process.env.TRENDRADAR_CONTAINER || "workbench-trendradar";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) { active.delete(key); throw new Error("TrendRadar 容器名称不合法"); }
  try {
    const previous = await readState();
    signal.throwIfAborted();
    const child = spawn("docker", ["exec", "-i", container, "python", "-u", "-c", trendRadarRunner], { stdio: ["pipe", "pipe", "pipe"] });
    // Closing stdin makes the Python reader terminate the isolated run too.
    const abort = () => { child.stdin.end(); child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", () => reject(new Error("无法启动 TrendRadar，请确认 Docker 已安装且正在运行")));
      child.once("close", code => resolve(code));
    });
    // Attach immediately so a process startup failure cannot be unhandled.
    void closed.catch(() => {}); // The same rejection is awaited and reported below.
    let pipeError = false;
    child.stdin.on("error", () => { pipeError = true; });
    let diagnostic = "";
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-1500); });
    const fallbackReasons: string[] = [];
    let result: unknown;
    let failure = "";
    try {
      child.stdin.write(JSON.stringify({ settings, databases: previous?.databases || [] }) + "\n");
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        signal.throwIfAborted();
        let envelope: Record<string, unknown>;
        try { envelope = JSON.parse(line); }
        catch { throw new Error("TrendRadar 返回协议无效，请检查容器版本"); }
        if (envelope.type === "model") {
          const request = modelMessage.parse(envelope);
          const response = await chatCompleteStrict(request.messages, undefined, { signal, maxOutputTokens: request.maxTokens, policy: "trendradar" });
          if (response.fallbackReason) fallbackReasons.push(response.fallbackReason);
          child.stdin.write(JSON.stringify({ text: response.text }) + "\n");
        } else if (envelope.type === "progress") {
          const progress = z.object({ stage: z.string(), message: z.string(), progress: z.number().min(0).max(100) }).parse(envelope);
          await options.onProgress?.(progress);
        } else if (envelope.type === "result") result = envelope;
        else if (envelope.type === "error") failure = String(envelope.message);
        else throw new Error("TrendRadar 返回了未知事件，请检查容器版本");
      }
      const code = await closed;
      signal.throwIfAborted();
      if (code !== 0 || !result || pipeError || failure) {
        throw new Error(failure || `TrendRadar 执行失败，请检查 Docker 容器 ${container} 是否运行及版本兼容性${diagnostic.includes("No such container") ? "（容器不存在）" : ""}；已保留上次报告`);
      }
      const state = trendRadarNativeStateSchema.parse({ ...(result as object), schemaVersion: 1, settings,
        generatedAt: new Date().toISOString(), fallback: fallbackReasons.length > 0, ...(fallbackReasons.length ? { fallbackReason: [...new Set(fallbackReasons)].join("；") } : {}) });
      signal.throwIfAborted();
      // One atomic record publishes HTML, metadata and native classification
      // checkpoints together, so failed/cancelled runs keep the last report.
      await writeJsonFile(key, state);
      return publicReport(state);
    } finally {
      signal.removeEventListener("abort", abort);
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed.catch(() => {}); // Preserve the original model/protocol error.
    }
  } catch (error) {
    if (signal.aborted) throw new Error(options.signal?.aborted ? "TrendRadar 任务已取消，已保留上次报告" : "TrendRadar 超过 15 分钟时限，已保留上次报告，请重试");
    throw error;
  } finally { active.delete(key); }
}
