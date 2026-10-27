import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { fetchBilibiliHttp } from "../src/lib/bilibili-http";

test("B站 HTTP 代理可跨请求复用、传递取消，未配置时仍直连", async () => {
  const original = process.env.BILIBILI_HTTP_PROXY;
  const sockets = new Set<Socket>();
  let tunnels = 0;
  const target = createServer((req, res) => {
    if (req.url === "/hold") return;
    res.end('{"code":0}');
  });
  const proxy = createServer((req, res) => {
    assert.match(req.url || "", /^http:\/\/bilibili\.fixture\.test\//);
    if (req.url?.endsWith("/hold")) return;
    res.end('{"code":0}');
  });
  proxy.on("connection", () => { tunnels++; });
  for (const server of [target, proxy]) {
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  }
  const targetAddress = target.address();
  const proxyAddress = proxy.address();
  assert.ok(targetAddress && typeof targetAddress === "object");
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  try {
    process.env.BILIBILI_HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await (await fetchBilibiliHttp("http://bilibili.fixture.test/view")).json(), { code: 0 });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(tunnels, 1);
    const controller = new AbortController();
    const request = fetchBilibiliHttp("http://bilibili.fixture.test/hold", { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    assert.equal((await fetchBilibiliHttp("http://bilibili.fixture.test/view")).status, 200);
    delete process.env.BILIBILI_HTTP_PROXY;
    assert.equal((await fetchBilibiliHttp(`http://127.0.0.1:${targetAddress.port}/view`)).status, 200);
  } finally {
    if (original === undefined) delete process.env.BILIBILI_HTTP_PROXY;
    else process.env.BILIBILI_HTTP_PROXY = original;
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});
