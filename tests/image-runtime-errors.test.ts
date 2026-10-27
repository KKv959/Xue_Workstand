import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { callImageApi } from "../src/lib/image-runtime";

test("中转服务 403 额度不足与真正鉴权失败分别展示，不泄露原始响应", async () => {
  let status = 403;
  let code = "insufficient_user_quota";
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code, message: "SECRET_MUST_NOT_LEAK" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = { apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}`, model: "gpt-image-2", size: "1920x1080", quality: "auto", format: "png" as const, proxyUrl: "" };
  const run = () => callImageApi({ config, prompt: "test", referenceFiles: [] });
  try {
    await assert.rejects(run(), { message: "图片服务额度不足，请在中转服务补充余额或更换可用密钥。", kind: "quota" });
    code = "invalid_api_key";
    await assert.rejects(run(), { kind: "auth" });
    status = 401;
    await assert.rejects(run(), { kind: "auth" });
    status = 429;
    code = "insufficient_quota";
    await assert.rejects(run(), { kind: "quota" });
    code = "rate_limit_exceeded";
    await assert.rejects(run(), { kind: "rate_limit" });
    status = 503;
    code = "model_not_found";
    await assert.rejects(run(), { kind: "model_unavailable" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
