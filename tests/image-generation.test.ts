import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateImages } from "../src/lib/image-generation";
import { callImageApi, defaultImageProfileId, imageConfig } from "../src/lib/image-runtime";
import { imageGenerationInputSchema } from "../src/lib/image-generation-types";
import { getImageFile, getImageRecord, listImageRecords, saveImageFile } from "../src/lib/storage/images";
import { isResumableJobKind } from "../src/lib/job-persistence";
import { isJobKindAllowedForAppMode } from "../src/lib/app-mode";
import { imageMentionToken, resolveImageMentions } from "../src/lib/image-mentions";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const input = { prompt: "一只猫", size: "1024x1024" as const, quality: "low" as const, count: 2, referenceIds: [] };

test("生图使用 JSON 文生图和 multipart 参考图；部分失败保留图片，摘要不携带正文", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-generation-test-"));
  const env = { ...process.env };
  const requests: Array<{ url: string; type: string; body: string; raw: Buffer }> = [];
  let failAt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url || "", type: request.headers["content-type"] || "", body: Buffer.concat(chunks).toString(), raw: Buffer.concat(chunks) });
    response.setHeader("Content-Type", "application/json");
    if (requests.length === failAt) { response.writeHead(429); response.end(JSON.stringify({ error: "SECRET_MUST_NOT_LEAK" })); return; }
    response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, IMAGE_API_KEY: "test-key", IMAGE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, IMAGE_MODEL: "gpt-image-2.5", IMAGE_PROXY_URL: "", CHAT_PROXY_URL: "" });
  try {
    assert.deepEqual(await listImageRecords(), { records: [], total: 0 });
    const changes: boolean[] = [];
    const record = await generateImages("image-test-1", input, { onProgress: async (_message, _progress, saved) => { changes.push(saved); } });
    assert.equal(record.images.length, 2);
    assert.equal(record.schemaVersion, 1);
    assert.equal(requests[0].url, "/v1/images/generations");
    assert.match(requests[0].type, /application\/json/);
    assert.equal(JSON.parse(requests[0].body).model, "gpt-image-2.5");
    assert.equal(changes.filter(Boolean).length, 3);
    assert.deepEqual((await getImageFile(record.images[0].id)).bytes, png);
    const listing = await listImageRecords();
    assert.equal(listing.total, 1);
    assert.equal("prompt" in listing.records[0], false);
    assert.equal("images" in listing.records[0], false);
    const reference = await saveImageFile(png, "reference.png");
    await generateImages("image-test-2", { ...input, count: 1, referenceIds: [reference.id] }, { onProgress: async () => {} });
    assert.equal(requests[2].url, "/v1/images/edits");
    assert.match(requests[2].type, /multipart\/form-data; boundary=/);
    assert.match(requests[2].body, /name="image\[\]"/);
    const branchPrompt = `调整 ${imageMentionToken(reference.id, "人物照")} 的表情`;
    const branch = await generateImages("image-test-branch", { ...input, count: 1, canvasId: record.id, parentRecordId: record.id, parentImageId: record.images[0].id, referenceIds: [record.images[0].id, reference.id], prompt: branchPrompt }, { onProgress: async () => {} });
    assert.match(requests[3].body, /参考图 2（人物照）/);
    assert.doesNotMatch(requests[3].body, /@\[/);
    assert.equal(branch.prompt, branchPrompt);
    assert.equal((await getImageRecord(branch.id))?.parentImageId, record.images[0].id);
    const board = await listImageRecords(0, 40, record.id);
    assert.deepEqual(new Set(board.records.map((item) => item.id)), new Set([record.id, branch.id]));
    assert.equal(board.records.find((item) => item.id === branch.id)?.parentRecordId, record.id);
    assert.equal((await listImageRecords(1, 1, record.id)).records.length, 1);
    await assert.rejects(generateImages("invalid-branch", { ...input, canvasId: "another-board", parentRecordId: record.id }, { onProgress: async () => {} }), /画布不一致/);
    assert.equal(await getImageRecord("invalid-branch"), null);
    await assert.rejects(generateImages("missing-mention", { ...input, prompt: branchPrompt }, { onProgress: async () => {} }), /已不在参考图/);
    assert.equal(await getImageRecord("missing-mention"), null);
    const references = [];
    for (let index = 0; index < 6; index++) references.push(await saveImageFile(png, `reference-${index + 1}.png`));
    const ordered = [...references].reverse();
    const multiPrompt = references.map((image) => imageMentionToken(image.id, image.name)).join("、") + `，再次参考 ${imageMentionToken(references[0].id, references[0].name)}`;
    await generateImages("image-test-six-references", { ...input, count: 1, referenceIds: ordered.map((image) => image.id), prompt: multiPrompt }, { onProgress: async () => {} });
    const request = requests.at(-1)!;
    const multipart = await new Response(new Uint8Array(request.raw), { headers: { "Content-Type": request.type } }).formData();
    const files = multipart.getAll("image[]") as File[];
    assert.equal(request.url, "/v1/images/edits");
    assert.equal(files.length, 6, "六张不同参考图均应发送，重复 @ 不重复上传");
    for (let index = 0; index < files.length; index++) {
      assert.equal(files[index].name, `${ordered[index].id}.${ordered[index].format}`);
      assert.deepEqual(Buffer.from(await files[index].arrayBuffer()), png);
      assert.ok(String(multipart.get("prompt")).includes(`参考图 ${index + 1}（${ordered[index].name}）`));
    }
    assert.equal(multipart.get("prompt"), resolveImageMentions(multiPrompt, ordered.map((image) => image.id)));
    failAt = requests.length + 2;
    await assert.rejects(generateImages("image-test-partial", input, { onProgress: async () => {} }), /返回 429/);
    assert.equal((await getImageRecord("image-test-partial"))?.images.length, 1);
    assert.equal((await getImageRecord("image-test-1"))?.images.length, 2);
    const controller = new AbortController();
    await assert.rejects(generateImages("image-test-cancel", input, { signal: controller.signal, onProgress: async (_message, _progress, saved) => {
      if (saved && (await getImageRecord("image-test-cancel"))?.images.length === 1) controller.abort();
    } }), { name: "AbortError" });
    assert.equal((await getImageRecord("image-test-cancel"))?.images.length, 1);
    await assert.rejects(getImageRecord("../bad"), /不合法/);
    await assert.rejects(saveImageFile(Buffer.from("<html>upstream failed</html>"), "fake.png"), /图片内容无效/);
    await fs.writeFile(path.join(root, "images", "records", "broken.json"), "{");
    await assert.rejects(listImageRecords(), /损坏/);
    const config = { ...imageConfig(), apiKey: "" };
    await assert.rejects(callImageApi({ config, prompt: "test", referenceFiles: [] }), /未配置/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("图片引用绑定 ID，重排后使用正确序号；删除、重复和越界显式失败", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const prompt = `${imageMentionToken(a, "人物照")} 参考 ${imageMentionToken(b, "姿势图")}`;
  assert.equal(resolveImageMentions(prompt, [b, a]), "参考图 2（人物照） 参考 参考图 1（姿势图）");
  assert.throws(() => resolveImageMentions(prompt, [a]), /已不在参考图/);
  assert.throws(() => resolveImageMentions(prompt, [a, a]), /重复/);
  assert.equal(resolveImageMentions("旧提示词参考图一", [a]), "旧提示词参考图一");
  assert.equal(imageGenerationInputSchema.safeParse({ ...input, canvasId: "../escape" }).success, false);
  assert.equal(imageGenerationInputSchema.safeParse({ ...input, referenceIds: Array(7).fill(a) }).success, false);
});

test("生图参数与运行模式边界；重启不自动重复收费", () => {
  assert.equal(imageGenerationInputSchema.safeParse({ ...input, prompt: "   " }).success, false);
  assert.equal(imageGenerationInputSchema.safeParse({ ...input, count: 5 }).success, false);
  assert.equal(imageGenerationInputSchema.safeParse({ ...input, referenceIds: ["../secret"] }).success, false);
  assert.equal(isResumableJobKind("image-generation"), false);
  assert.equal(isJobKindAllowedForAppMode("image-generation", "gross-margin"), false);
  assert.equal(isJobKindAllowedForAppMode("image-generation", "workspace"), true);
});

test("图片配置按 ID 隔离密钥，自定义尺寸兼容旧记录", () => {
  const old = process.env.IMAGE_PROFILES;
  const oldDefault = process.env.IMAGE_DEFAULT_PROFILE;
  try {
    process.env.IMAGE_PROFILES = JSON.stringify([{ id: "test-profile", label: "测试", model: "gpt-image-2", apiKey: "profile-key", baseUrl: "https://example.com/v1" }]);
    process.env.IMAGE_DEFAULT_PROFILE = "test-profile";
    assert.equal(imageConfig("test-profile").apiKey, "profile-key");
    assert.equal(imageConfig("test-profile").model, "gpt-image-2");
    assert.equal(defaultImageProfileId(), "test-profile");
    assert.throws(() => imageConfig("missing"), /不存在/);
    assert.equal(imageGenerationInputSchema.safeParse({ ...input, size: "3840x2160", profileId: "test-profile" }).success, true);
    assert.equal(imageGenerationInputSchema.safeParse({ ...input, size: "auto" }).success, true);
    assert.equal(imageGenerationInputSchema.safeParse({ ...input, size: "99999x1" }).success, false);
    assert.equal(imageGenerationInputSchema.safeParse(input).success, true);
  } finally {
    if (old === undefined) delete process.env.IMAGE_PROFILES; else process.env.IMAGE_PROFILES = old;
    if (oldDefault === undefined) delete process.env.IMAGE_DEFAULT_PROFILE; else process.env.IMAGE_DEFAULT_PROFILE = oldDefault;
  }
});
