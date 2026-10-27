import { isLocalSameOriginRequest } from "@/lib/api-route";
import { createNdjsonStream } from "@/lib/streaming";
import { loadModelSettings } from "@/lib/pi-settings";
import { withPiNetwork } from "@/lib/pi-network";
import { z } from "zod";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isLocalSameOriginRequest(request)) {
    return Response.json({ error: "为保护订阅凭证，请在本机工作站页面完成登录" }, { status: 403 });
  }
  const selection = z.object({ provider: z.enum(["openai", "openai-codex"]) }).strict().safeParse(await request.json().catch(() => null));
  if (!selection.success) return Response.json({ error: "请选择有效的订阅来源" }, { status: 400 });
  const { provider } = selection.data;
  const stream = createNdjsonStream(async (emit, signal) => {
    const { runtime, settings } = await loadModelSettings();
    const deviceId = settings.getOrCreateDeviceId();
    await settings.flush();
    let exchanging = false;
    try { await withPiNetwork(() => runtime.login(provider, "oauth", {
      signal,
      prompt: prompt => {
        if (prompt.type === "select" && provider === "openai-codex") return Promise.resolve("browser");
        if (prompt.type !== "manual_code") return Promise.reject(new Error("此登录步骤需要终端操作"));
        return new Promise<string>((_resolve, reject) => {
        const abort = () => reject(new Error("浏览器授权已完成或登录已取消"));
        if (prompt.signal?.aborted) return abort();
        prompt.signal?.addEventListener("abort", abort, { once: true });
        });
      },
      notify: event => {
        if (event.type === "auth_url") emit({ type: "result", data: { verificationUri: event.url } });
        else if (event.type === "progress") {
          exchanging = true;
          emit({ type: "stage", stage: "exchange", message: "授权回调已收到，正在确认订阅凭证" });
        }
      }
    }, { agentName: "内容工作站", getDeviceId: () => deviceId })); }
    catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : "";
      const reason = /unsupported_country_region_territory/i.test(detail) ? "订阅令牌接口拒绝当前网络出口，请检查工作站 CHAT_PROXY_URL 代理配置后重新连接"
        : /Port 1455|EADDRINUSE|in use/i.test(detail) ? "本机 1455 端口已被占用，请关闭其他登录窗口后重试"
        : provider === "openai" && /chatgpt\.tokens\.use\.direct|invalid_scope|insufficient_scope/i.test(detail) ? "当前账号未获得 OpenAI 直连模型权限（chatgpt.tokens.use.direct）。请改用 ChatGPT 订阅（Codex）连接"
        : /invalid_grant|token_expired/i.test(detail) ? "本次授权码已失效，请重新连接并打开新生成的授权页面"
        : /token (?:exchange|request) failed \(40[13]\)|invalid.*token|accountId/i.test(detail) ? "浏览器授权成功，但订阅凭证被服务拒绝，请确认登录的 ChatGPT 账号后重试"
        : /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(detail) ? "订阅授权时连接 OpenAI 失败，请检查本机网络或代理后重试"
        : /state mismatch|Missing authorization code|authorization failed/i.test(detail) ? "授权回调无效或被拒绝，请关闭旧授权页面并重新连接"
        : exchanging ? "浏览器授权成功，但令牌兑换或本机保存失败，请检查网络和 Pi 配置后重试"
        : "订阅登录未完成，请使用本次连接生成的授权页面，或检查本机 1455 端口";
      throw new Error(reason);
    }
    emit({ type: "result", data: { connected: true } });
  }, { signal: request.signal });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
