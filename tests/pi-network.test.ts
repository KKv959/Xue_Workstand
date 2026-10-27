import assert from "node:assert/strict";
import test from "node:test";
import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { chatDispatcher } from "../src/lib/model-runtime";
import { withPiNetwork } from "../src/lib/pi-network";

test("Pi 使用已有代理，其他并发请求继续使用原网络", async () => {
  const originalDispatcher = getGlobalDispatcher();
  const originalProxy = process.env.CHAT_PROXY_URL;
  const calls: string[] = [];
  const fallback = new class extends Dispatcher {
    dispatch(): boolean { calls.push("direct"); return true; }
  }();
  const proxyUrl = "http://127.0.0.1:19991";
  const proxy = chatDispatcher(proxyUrl)!;
  const originalDispatch = proxy.dispatch;
  proxy.dispatch = () => { calls.push("proxy"); return true; };
  setGlobalDispatcher(fallback);
  process.env.CHAT_PROXY_URL = proxyUrl;
  const dispatch = () => getGlobalDispatcher().dispatch(
    { origin: "https://auth.openai.com", path: "/oauth/token", method: "POST" },
    {} as Dispatcher.DispatchHandler
  );
  try {
    await Promise.all([
      withPiNetwork(async () => { await Promise.resolve(); dispatch(); }),
      Promise.resolve().then(dispatch)
    ]);
    assert.deepEqual(calls.sort(), ["direct", "proxy"]);
  } finally {
    proxy.dispatch = originalDispatch;
    setGlobalDispatcher(originalDispatcher);
    if (originalProxy === undefined) delete process.env.CHAT_PROXY_URL;
    else process.env.CHAT_PROXY_URL = originalProxy;
  }
});
