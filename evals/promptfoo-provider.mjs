const DEFAULT_APP_URL = "http://127.0.0.1:3000";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export default class WorkbenchWriterProvider {
  constructor(options = {}) {
    this.providerId = options.id || "workbench-writer";
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context = {}) {
    const appUrl = String(this.config.appUrl || process.env.PROMPTFOO_APP_URL || DEFAULT_APP_URL).replace(/\/$/, "");
    const platform = String(this.config.platform || process.env.PROMPTFOO_STYLE_PLATFORM || "bilibili");
    const accountId = String(this.config.accountId || process.env.PROMPTFOO_STYLE_ACCOUNT_ID || "").trim();
    if (!accountId) {
      return { error: "缺少 PROMPTFOO_STYLE_ACCOUNT_ID：请指定一个已有风格卡的账号目录名。" };
    }

    const vars = context.vars || {};
    const task = String(vars.task || prompt || "").trim();
    const source = String(vars.source || "").trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(this.config.timeoutMs || DEFAULT_TIMEOUT_MS));
    try {
      const response = await fetch(`${appUrl}/api/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          mode: "topic",
          prompt: task,
          sourceText: source,
          styleRefs: [{ targetType: "account", platform, accountId }],
          save: false,
          useWebResearch: false
        }),
        signal: controller.signal
      });
      const bodyText = await response.text();
      let body;
      try { body = JSON.parse(bodyText); } catch { body = null; }
      if (!response.ok) return { error: body?.error || `工作台写作接口失败（HTTP ${response.status}）` };

      const result = body?.kind === "write-batch" ? body.results?.[0] : body;
      const output = typeof result?.content === "string" ? result.content.trim() : "";
      if (!output) return { error: "工作台写作接口没有返回可评测的 content" };
      return {
        output,
        metadata: {
          model: result?.usedModel,
          fallback: Boolean(result?.fallback),
          contextFingerprint: result?.contextFingerprint
        }
      };
    } catch (error) {
      return { error: error?.name === "AbortError" ? "工作台写作评测超时" : `工作台写作评测失败：${error?.message || String(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
