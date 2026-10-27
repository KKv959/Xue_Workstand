import { promises as dns } from "dns";
import { isIP } from "net";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Agent, request } from "undici";

export async function downloadPublicHttpMedia(value: string, target: string, options: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(options.signal ? [options.signal] : [])]);
  let url = value;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    signal.throwIfAborted();
    const addresses = await assertPublicHttpUrl(url);
    const address = addresses[0];
    const dispatcher = new Agent({ connect: { lookup: (_host, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, addresses);
      else callback(null, address.address, address.family);
    } } });
    try {
      const response = await request(url, { dispatcher, signal, headers: options.headers });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.body.destroy();
        const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
        if (!location || redirects === 5) throw new Error("媒体链接重定向过多或缺少目标地址。");
        url = new URL(location, url).href;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.destroy();
        throw new Error(`媒体下载失败（HTTP ${response.statusCode}），请刷新媒体地址后重试。`);
      }
      await pipeline(response.body, createWriteStream(target, { flags: "wx" }), { signal });
      return;
    } finally {
      await dispatcher.close();
    }
  }
}

export async function assertPublicHttpUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error("媒体链接格式不正确。"), { statusCode: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw Object.assign(new Error("远程媒体只支持 HTTP/HTTPS 链接。"), { statusCode: 400 });
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || parsed.username || parsed.password) {
    throw Object.assign(new Error("远程媒体不能指向本机或内网地址，也不能包含登录凭据。"), { statusCode: 400 });
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw Object.assign(new Error("远程媒体不能指向本机或内网地址。"), { statusCode: 400 });
  }
  return addresses;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (isIP(normalized) === 6) {
    // IPv4-mapped hexadecimal addresses must not bypass the IPv4 checks.
    if (/^::ffff:[\da-f]+:[\da-f]+$/.test(normalized)) {
      const parts = normalized.split(":").slice(-2).map((part) => parseInt(part, 16));
      return isPrivateAddress(`${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`);
    }
    return normalized === "::" || normalized === "::1" || /^(?:fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
  }
  return true;
}
