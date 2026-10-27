import nextEnv from "@next/env";
import path from "node:path";
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() { throw new Error("模型配置读取失败"); } });
const { getChatConfig, postModelRequest, chatCompletionPayload, classifyModelFailure } = await import("../src/lib/model-runtime.ts");
const { writeJsonFile } = await import("../src/lib/storage/fs.ts");
const base = getChatConfig();
const pathComparison = process.argv.includes("--compare-v1");
const variants = pathComparison ? ["chat_completions", "responses"].flatMap(api => [true, false].map(withV1 => ({
  name: `${api}-${withV1 ? "with-v1" : "without-v1"}`, model: base.model, proxy: true, api, withV1
}))) : [
  { name: "configured-model-proxy-chat", model: base.model, proxy: true, api: "chat_completions" },
  { name: "astra-proxy-chat", model: "gpt-6-astra", proxy: true, api: "chat_completions" },
  { name: "configured-model-direct-chat", model: base.model, proxy: false, api: "chat_completions" },
  { name: "configured-model-proxy-responses", model: base.model, proxy: true, api: "responses" }
];
const results = [];
const destination = path.resolve("outputs/model-service-diagnostic", new Date().toISOString().replace(/[:.]/g, "-"), "results.json");
async function run(variant) {
  const start = performance.now();
  const result = { ...variant, headersMs: null, firstTextMs: null, status: "running", events: [], text: "" };
  const config = { ...base, model: variant.model, proxyUrl: variant.proxy ? base.proxyUrl : "" };
  if (pathComparison) {
    config.baseUrl = new URL(base.baseUrl).origin + (variant.withV1 ? "/v1" : "");
    config.responsesUrl = "";
    config.chatCompletionsUrl = "";
  }
  const responses = variant.api === "responses";
  const payload = responses
    ? { model: config.model, input: "只回复OK", reasoning: { effort: "low" }, stream: true, max_output_tokens: 256, store: false }
    : chatCompletionPayload({ config, messages: [{ role: "user", content: "只回复OK" }], reasoningEffort: "low", stream: true, maxOutputTokens: 256 });
  try {
    const response = await postModelRequest(config, responses ? "/responses" : "/chat/completions", payload, AbortSignal.timeout(45000));
    result.headersMs = Math.round(performance.now() - start);
    result.httpStatus = response.status;
    result.contentType = response.headers.get("content-type");
    result.finalPath = new URL(response.url).pathname;
    if (!result.contentType?.includes("text/event-stream")) {
      const body = await response.text();
      if (result.contentType?.includes("text/html") || /^\s*<!doctype html|^\s*<html/i.test(body)) {
        result.events.push("html-not-model-api");
      } else {
        let parsed;
        try { parsed = JSON.parse(body); } catch { result.events.push("non-json-non-sse"); }
        if (parsed) {
          if (parsed.error) result.events.push("upstream-error");
          result.text = (parsed.choices || []).map(c => c.message?.content || "").join("") ||
            (parsed.output || []).flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("");
        }
      }
      result.status = result.text.trim().toUpperCase() === "OK" && !result.events.length ? "completed" : "failed";
      result.totalMs = Math.round(performance.now() - start);
      console.log(JSON.stringify(result));
      return result;
    }
    let buffer = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    function consume(line) {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]" || !data) return;
      let event;
      try { event = JSON.parse(data); } catch { result.events.push("invalid-json"); return; }
      if (event.error || event.type === "response.failed") {
        const message = String(event.error?.message || event.response?.error?.message || "");
        result.events.push(/overload|capacity/i.test(message) ? "upstream-overloaded" : "upstream-error");
      }
      const text = event.type === "response.output_text.delta" ? event.delta : (event.choices || []).map(c => c.delta?.content || c.message?.content || "").join("");
      if (typeof text === "string" && text) { result.firstTextMs ??= Math.round(performance.now() - start); result.text += text; }
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      lines.forEach(consume);
    }
    consume(buffer);
    result.status = result.text.trim().toUpperCase() === "OK" && !result.events.length ? "completed" : "failed";
  } catch (error) {
    const failure = classifyModelFailure(error);
    result.status = "failed"; result.failure = { kind: failure.kind, message: failure.userMessage };
    if (typeof error?.status === "number") result.httpStatus = error.status;
  }
  result.totalMs = Math.round(performance.now() - start);
  // No request headers, credentials, upstream error bodies or full config are saved.
  console.log(JSON.stringify(result));
  return result;
}
// Two at a time to bound load; no retries and no publication/content-generation workload.
for (let index = 0; index < variants.length; index += 2) {
  results.push(...await Promise.all(variants.slice(index, index + 2).map(run)));
  await writeJsonFile(destination, { schemaVersion: 1, purpose: "模型连通性诊断", results });
}
console.log(destination);
