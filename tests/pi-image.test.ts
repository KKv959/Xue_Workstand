import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runPiImage } from "../src/lib/pi-runtime-local";
import { validateAiSettings } from "../src/lib/storage/ai-settings";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveAiSettings } from "../src/lib/storage/ai-settings";
import { generateImages } from "../src/lib/image-generation";
import { getImageFile, getImageRecord, saveImageFile } from "../src/lib/storage/images";

test("订阅生图提取图片、传递参考图和参数，失败与取消不回退", async t => {
  let mode = "ok";
  let calls = 0;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  t.mock.method(ModelRuntime, "create", async () => ({
    getError: () => undefined,
    listCredentials: async () => [{ providerId: "openai-codex", type: "oauth" }],
    getModel: () => ({ id: "gpt-6.1-sol" }),
    streamSimple: (_model: unknown, context: { messages: { content: unknown[] }[] }, options: { onPayload: (body: Record<string, unknown>) => void; onProviderStreamEvent: (event: unknown) => void }) => {
      calls++;
      assert.equal(context.messages[0].content.length, 2);
      const body: Record<string, unknown> = {};
      options.onPayload(body);
      assert.deepEqual(body.tool_choice, { type: "image_generation" });
      assert.deepEqual(body.tools, [{ type: "image_generation", size: "1024x1024", quality: "low", output_format: "png" }]);
      if (mode === "ok") options.onProviderStreamEvent({ type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: png.toString("base64") } });
      return { result: async () => ({ stopReason: mode === "quota" ? "error" : "stop", errorMessage: "usage_limit_reached" }) };
    }
  }));
  const input = { prompt: "测试", size: "1024x1024", quality: "low", images: ["data:image/png;base64,YQ=="] };
  assert.deepEqual(await runPiImage(input), png);
  mode = "quota";
  await assert.rejects(runPiImage(input), /额度不足/);
  mode = "empty";
  await assert.rejects(runPiImage(input), /没有返回完整图片/);
  await assert.rejects(runPiImage(input, AbortSignal.abort()), /abort/i);
  assert.equal(calls, 3);
  const settings = { schemaVersion: 1, revision: 0, updatedAt: null, overrides: { image_generate: { model: "", effort: "none", source: "subscription" } } };
  assert.equal(validateAiSettings(settings).overrides.image_generate?.source, "subscription");
  assert.throws(() => validateAiSettings({ ...settings, overrides: { image_generate: { model: "", effort: "none", source: "auto" } } }), /不自动切换/);
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-image-test-"));
  const originalRoot = process.env.STYLE_LIBRARY_DIR;
  const originalEnabled = process.env.PI_ENABLED;
  process.env.STYLE_LIBRARY_DIR = root;
  process.env.PI_ENABLED = "1";
  try {
    await saveAiSettings(validateAiSettings(settings));
    const reference = await saveImageFile(png, "参考图");
    mode = "ok";
    const record = await generateImages("fixture", { prompt: "测试", size: "1024x1024", quality: "low", referenceIds: [reference.id], count: 1 }, { onProgress: async () => {} });
    assert.equal(record.source, "subscription");
    assert.equal(record.images.length, 1);
    assert.deepEqual((await getImageFile(record.images[0].id)).bytes, png);
    assert.equal((await getImageRecord(record.id))?.source, "subscription");
    mode = "quota";
    await assert.rejects(generateImages("failed", { prompt: "测试", size: "1024x1024", quality: "low", referenceIds: [reference.id], count: 1 }, { onProgress: async () => {} }), /额度不足/);
    assert.equal((await getImageRecord("failed"))?.images.length, 0);
  } finally {
    if (originalRoot === undefined) delete process.env.STYLE_LIBRARY_DIR; else process.env.STYLE_LIBRARY_DIR = originalRoot;
    if (originalEnabled === undefined) delete process.env.PI_ENABLED; else process.env.PI_ENABLED = originalEnabled;
    await rm(root, { recursive: true, force: true });
  }
});
