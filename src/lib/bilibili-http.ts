import { fetch as proxyFetch, ProxyAgent, type RequestInit as ProxyRequestInit } from "undici";

let cachedProxy: { url: string; agent: ProxyAgent } | undefined;

// Node 的 fetch 不会自动跟随 macOS 系统代理；只影响 B站 HTTP 请求。
export function fetchBilibiliHttp(url: string, init: RequestInit = {}): Promise<Response> {
  const proxyUrl = process.env.BILIBILI_HTTP_PROXY?.trim();
  if (!proxyUrl) return fetch(url, init);
  if (cachedProxy?.url !== proxyUrl) {
    const previous = cachedProxy;
    cachedProxy = { url: proxyUrl, agent: new ProxyAgent(proxyUrl) };
    if (previous) {
      // 关闭旧连接池不影响本次请求，失败仅记录不含代理地址的提示。
      void previous.agent.close().catch(() => console.warn("B站旧代理连接池关闭失败"));
    }
  }
  return proxyFetch(url, { ...init as ProxyRequestInit, dispatcher: cachedProxy.agent }) as unknown as Promise<Response>;
}
