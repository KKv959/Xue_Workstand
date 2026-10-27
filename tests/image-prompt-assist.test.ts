import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendImageMention, imageMentionToken, removeImageMention } from "../src/lib/image-mentions";
import { validateAssistedPrompt } from "../src/lib/image-prompt-assist";
import { imagePromptAssistSchema } from "../src/lib/image-prompt-assist-types";
import { isResumableJobKind } from "../src/lib/job-persistence";
import { isJobKindAllowedForAppMode } from "../src/lib/app-mode";

test("参考同步只移除目标引用，添加不重复，AI 必须保留引用", () => {
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  const prompt = `主体 ${imageMentionToken(a, "人物")}，背景 ${imageMentionToken(b, "背景")}`;
  assert.equal(appendImageMention(prompt, a, "人物"), prompt);
  const removed = removeImageMention(prompt, a);
  assert.ok(!removed.includes(a)); assert.ok(removed.includes(b));
  assert.equal(validateAssistedPrompt(prompt, prompt + " 柔和光线"), prompt + " 柔和光线");
  assert.throws(() => validateAssistedPrompt(prompt, removed), /引用/);
  assert.throws(() => validateAssistedPrompt("一只猫", prompt), /引用/);
  assert.equal(imagePromptAssistSchema.safeParse({ prompt: " ", mode: "polish" }).success, false);
  assert.equal(isResumableJobKind("image-prompt-assist"), false);
  assert.equal(isJobKindAllowedForAppMode("image-prompt-assist", "gross-margin"), false);
});

test("图片助手默认 gpt-6.1-sol high，其他对话仍用原配置", async () => {
  const { createServer } = await import("node:http");
  const { assistImagePrompt } = await import("../src/lib/image-prompt-assist");
  const { chatCompleteStrict } = await import("../src/lib/ai");
  const original = { ...process.env };
  const library = await mkdtemp(path.join(tmpdir(), "image-prompt-assist-test-"));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "一只猫，柔和光线" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    for (const key of Object.keys(process.env)) if (/^(CHAT_|OPENAI_|FHL_)/.test(key)) delete process.env[key];
    Object.assign(process.env, { STYLE_LIBRARY_DIR: library, PI_ENABLED: "0", CHAT_API_KEY: "fixture", CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, CHAT_MODEL: "original-model", CHAT_WIRE_API: "chat_completions", CHAT_FALLBACK_ENABLED: "0" });
    await assistImagePrompt({ prompt: "一只猫", mode: "polish" });
    assert.equal(requests[0].model, "gpt-6.1-sol");
    assert.equal(requests[0].reasoning_effort, "high");
    await chatCompleteStrict([{ role: "user", content: "一只猫" }]);
    assert.equal(requests[1].model, "original-model");
    // 用户覆盖应生效；默认值测试不能读取真实资料库的个人配置。
    const { readAiSettings, saveAiSettings } = await import("../src/lib/storage/ai-settings");
    const settings = await readAiSettings();
    await saveAiSettings({ ...settings, overrides: { image_prompt: { model: "gpt-5.6-sol", effort: "low" } } });
    await assistImagePrompt({ prompt: "一只猫", mode: "polish" });
    assert.equal(requests[2].model, "gpt-5.6-sol");
    assert.equal(requests[2].reasoning_effort, "low");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(library, { recursive: true, force: true });
  }
});
