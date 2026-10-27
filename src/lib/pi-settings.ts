import path from "node:path";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { withPiNetwork } from "./pi-network";

export async function verifyPiSelection(runtime: ModelRuntime, selection: { provider: string; model: string; thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }, signal: AbortSignal) {
  const model = runtime.getModel(selection.provider, selection.model);
  if (!model) throw Object.assign(new Error("所选模型不存在，请刷新列表后重试"), { status: 400 });
  const timeout = AbortSignal.timeout(45_000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  try {
    requestSignal.throwIfAborted();
    const result = await withPiNetwork(() => runtime.streamSimple(model, {
      messages: [{ role: "user", content: "Reply only OK.", timestamp: Date.now() }]
    }, { signal: requestSignal, reasoning: selection.thinking === "off" ? undefined : selection.thinking,
      transport: "sse", maxRetries: 0, cacheRetention: "none" }).result());
    requestSignal.throwIfAborted();
    if (result.stopReason !== "stop" || !result.content.some(item => item.type === "text" && item.text.trim())) {
      throw new Error(result.errorMessage || "empty response");
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const reason = signal.aborted ? "验证已取消"
      : timeout.aborted ? "订阅验证超过 45 秒，请稍后重试"
      : /not supported|model_not_found|subscription_sharing_user_not_eligible/i.test(raw) ? "当前订阅不支持此模型或接入方式，请更换型号或订阅来源"
      : /overload|503|error occurred while processing/i.test(raw) ? "订阅上游暂时过载，无法确认可用性，请稍后重试"
      : /quota|usage.limit|rate.limit|429/i.test(raw) ? "订阅额度不足或限流，请稍后重试"
      : /401|403|auth|credential|token/i.test(raw) ? "订阅鉴权失败，请重新连接订阅"
      : "订阅未返回完整文字，请检查网络或更换模型后重试";
    if (/过载|超过 45 秒|额度不足或限流|网络或更换模型/.test(reason)) return { verified: false, warning: reason };
    throw Object.assign(new Error(`${reason}；原默认配置未修改`), { status: 422 });
  }
  return { verified: true as const };
}

export async function loadModelSettings() {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  if (settings.drainErrors().length) throw new Error("Pi 配置文件损坏，请检查本机 settings.json");
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), refreshOnCreate: false });
  if (runtime.getError()) throw new Error("Pi 模型配置无效，请检查本机 models.json");
  return { runtime, settings };
}
