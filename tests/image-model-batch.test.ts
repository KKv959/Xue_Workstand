import assert from "node:assert/strict";
import test from "node:test";
import { imageModelBatch } from "../src/lib/image-model-batch";
import type { ImageGenerationConfig, ImageGenerationInput } from "../src/lib/image-generation-types";
const profiles: ImageGenerationConfig["profiles"] = [
  { id: "two4k", label: "2 4K", model: "gpt-image-2", resolution: "4k", configured: true },
  { id: "half", label: "2.5", model: "gpt-image-2.5", resolution: "1080p", configured: true },
];
const input: ImageGenerationInput = { profileId: "two4k", prompt: "测试", count: 2, size: "3840x2160", quality: "auto", referenceIds: [] };
test("每个模型保留张数和参考，按可用档位保留比例", () => {
  const result = imageModelBatch(input, ["gpt-image-2", "gpt-image-2.5"], profiles);
  assert.deepEqual(result.map(({profileId, count, size}) => ({profileId, count, size})), [
    { profileId: "two4k", count: 2, size: "3840x2160" }, { profileId: "half", count: 2, size: "1920x1080" },
  ]);
});
test("多选模式只勾选另一个模型时仍正确路由", () => {
  assert.equal(imageModelBatch(input, ["gpt-image-2.5"], profiles)[0].profileId, "half");
  assert.equal(imageModelBatch(input, [], profiles)[0], input);
});
test("自动比例在多模型与分辨率切换后仍保留", () => {
  assert.deepEqual(imageModelBatch({ ...input, size: "auto" }, ["gpt-image-2", "gpt-image-2.5"], profiles).map((item) => item.size), ["auto", "auto"]);
});
test("未配置模型在提交前显式失败", () => {
  assert.throws(() => imageModelBatch(input, ["missing"], profiles), /未配置/);
  assert.throws(() => imageModelBatch(input, ["gpt-image-2.5"], profiles.map(p => ({...p, configured:false}))), /未配置/);
});
