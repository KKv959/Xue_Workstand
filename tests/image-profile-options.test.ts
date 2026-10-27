import assert from "node:assert/strict";
import test from "node:test";
import { imageConfig, publicImageProfiles } from "../src/lib/image-runtime";
import { imageProfileForModel, imageRatioForSize, imageRatios, imageSizeForProfile } from "../src/lib/image-profile-options";

test("模型与分辨率独立选择，档位切换路由到独立密钥且不公开密钥", () => {
  const old = process.env.IMAGE_PROFILES;
  try {
    process.env.IMAGE_PROFILES = JSON.stringify([
      { id: "two", model: "gpt-image-2", label: "Image 2", resolution: "1080p", apiKey: "test-standard", baseUrl: "https://example.com/v1" },
      { id: "two2k", model: "gpt-image-2", label: "Image 2 2K", resolution: "2k", apiKey: "test-2k", baseUrl: "https://example.com/v1" },
      { id: "two4k", model: "gpt-image-2", label: "Image 2 4K", resolution: "4k", apiKey: "test-4k", baseUrl: "https://example.com/v1" },
      { id: "twohalf", model: "gpt-image-2.5", label: "Image 2.5", apiKey: "test-half", baseUrl: "https://example.com/v1" }
    ]);
    const profiles = publicImageProfiles().filter((p) => p.id !== "default");
    assert.equal(imageProfileForModel(profiles, "gpt-image-2", "4k")?.id, "two4k");
    assert.equal(imageProfileForModel(profiles, "gpt-image-2.5", "4k")?.id, "twohalf");
    assert.equal(imageConfig("two2k").apiKey, "test-2k");
    assert.equal(imageConfig("two4k").apiKey, "test-4k");
    assert.equal(JSON.stringify(profiles).includes("apiKey"), false);
    assert.equal(JSON.stringify(profiles).includes("test-4k"), false);
    assert.equal(imageSizeForProfile(profiles[0], "16:9"), "1920x1080");
    assert.equal(imageSizeForProfile(profiles[1], "16:9"), "2560x1440");
    assert.equal(imageSizeForProfile(profiles[2], "9:16"), "2160x3840");
    assert.equal(imageRatioForSize("1536x864"), "16:9");
    assert.equal(imageRatioForSize("800x1000"), "800:1000");
    assert.equal(imageSizeForProfile(profiles[2], "auto"), "auto");
    assert.equal(imageRatios[0], "auto");
    assert.equal(imageRatioForSize("auto"), "auto");
  } finally { if (old === undefined) delete process.env.IMAGE_PROFILES; else process.env.IMAGE_PROFILES = old; }
});
