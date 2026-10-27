import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { getChatConfig, postModelRequest } from "../src/lib/model-runtime";

test("代理连接跨模型请求复用，取消后仍可继续请求", async () => {
  let connections = 0;
  let hold = false;
  const proxy = createServer((req, res) => {
    assert.match(req.url || "", /^http:\/\/model\.example\.test\/v1\/chat\/completions$/);
    assert.equal(req.headers.authorization, "Bearer fixture");
    req.resume();
    if (hold) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"text":"partial"}\n\n');
    } else {
      res.end('{"ok":true}');
    }
  });
  proxy.on("connection", () => { connections++; });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const config = { ...getChatConfig(), apiKey: "fixture", baseUrl: "http://model.example.test/v1", chatCompletionsUrl: "", proxyUrl: `http://127.0.0.1:${address.port}` };
  try {
    for (let i = 0; i < 3; i++) {
      const response = await postModelRequest(config, "/chat/completions", {});
      assert.equal(await response.text(), '{"ok":true}');
      // Let Undici release the fully consumed connection back to its pool.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(connections, 1, "三次请求应只建立一条代理连接");
    hold = true;
    const controller = new AbortController();
    const response = await postModelRequest(config, "/chat/completions", {}, controller.signal);
    controller.abort();
    await assert.rejects(response.text(), { name: "AbortError" });
    hold = false;
    assert.equal(await (await postModelRequest(config, "/chat/completions", {})).text(), '{"ok":true}');
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
