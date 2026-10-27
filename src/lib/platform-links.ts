import type { GrossMarginPriceTable, Platform } from "./types";

export type LinkInputKind = "any" | "video" | "account";

export type ExtractedLinkInput = {
  raw: string;
  url: string;
  start: number;
  end: number;
};

type LinkInputOptions = {
  kind?: LinkInputKind;
};

type RemoteAssetFamily = "video" | "image";

export type VideoPlatform = Extract<GrossMarginPriceTable["platform"], "bilibili" | "douyin">;

const TRAILING_PUNCTUATION = /[)\]}>，。！？、；;,.!?）】\]]+$/;
const EXPLICIT_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const KNOWN_DOMAIN_PATTERN = /(?:v\.douyin\.com|www\.douyin\.com|douyin\.com|www\.iesdouyin\.com|iesdouyin\.com|b23\.tv|space\.bilibili\.com|www\.bilibili\.com|m\.bilibili\.com|bilibili\.com)\/[^\s<>"']+/gi;
const BILIBILI_VIDEO_HOSTS = ["www.bilibili.com", "m.bilibili.com", "bilibili.com"];
const DOUYIN_HOSTS = ["www.douyin.com", "douyin.com", "www.iesdouyin.com", "iesdouyin.com"];
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export function extractLinksFromInput(input?: string, options: LinkInputOptions = {}): ExtractedLinkInput[] {
  const text = input || "";
  if (!text.trim()) return [];

  const links = [
    ...collectPatternLinks(text, EXPLICIT_URL_PATTERN, options),
    ...collectPatternLinks(text, KNOWN_DOMAIN_PATTERN, options, true)
  ].sort((left, right) => left.start - right.start || right.end - left.end);

  const unique: ExtractedLinkInput[] = [];
  const seenRanges = new Set<string>();
  const seenUrls = new Set<string>();
  for (const link of links) {
    const rangeKey = `${link.start}:${link.end}`;
    const urlKey = link.url.toLowerCase();
    if (seenRanges.has(rangeKey) || seenUrls.has(urlKey)) continue;
    if (unique.some((existing) => link.start >= existing.start && link.end <= existing.end)) continue;
    seenRanges.add(rangeKey);
    seenUrls.add(urlKey);
    unique.push(link);
  }

  return unique;
}

export function extractFirstLinkFromInput(input?: string, options: LinkInputOptions = {}) {
  return extractLinksFromInput(input, options)[0]?.url || "";
}

export function normalizeLinkInput(input?: string, options: LinkInputOptions = {}) {
  const trimmed = input?.trim() || "";
  return extractFirstLinkFromInput(trimmed, options) || trimmed;
}

export function createUrlPreprocessor(options: LinkInputOptions = {}) {
  return (value: unknown) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return "";

    const extracted = extractFirstLinkFromInput(trimmed, options);
    if (extracted) return extracted;
    if (options.kind === "video" || options.kind === "account") return "";

    const token = trimLinkToken(trimmed);
    return /^https?:\/\//i.test(token) ? normalizeLinkToken(token) || token : token;
  };
}

export function isVideoLink(url: string) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;
  if (hostMatches(hostname, "b23.tv") || hostMatches(hostname, "v.douyin.com")) return true;
  if (BILIBILI_VIDEO_HOSTS.some((host) => hostMatches(hostname, host))) {
    return /(^|\/)(video\/)?BV[0-9A-Za-z]+/i.test(pathname) || /^\/video\//i.test(pathname);
  }
  if (DOUYIN_HOSTS.some((host) => hostMatches(hostname, host))) {
    return /\/(?:video|aweme\/share\/video)\//i.test(pathname) || parsed.searchParams.has("modal_id");
  }
  return false;
}

export function isAccountLink(url: string) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;
  if (hostMatches(hostname, "space.bilibili.com")) return /^\/\d+/.test(pathname);
  if (DOUYIN_HOSTS.some((host) => hostMatches(hostname, host))) {
    return /\/(?:user|share\/user)\//i.test(pathname) || parsed.searchParams.has("sec_uid");
  }
  return isVideoLink(url);
}

export function extractVideoUrl(input?: string) {
  return extractFirstLinkFromInput(input, { kind: "video" });
}

export function normalizeVideoUrlInput(input: string) {
  return normalizeLinkInput(input, { kind: "video" });
}

export function detectVideoPlatform(input?: string): VideoPlatform | null {
  const text = input || "";
  const url = extractVideoUrl(text) || text.trim();
  const parsed = parseHttpUrl(withHttpScheme(url));
  if (parsed) {
    const hostname = parsed.hostname.toLowerCase();
    if (hostMatches(hostname, "b23.tv") || BILIBILI_VIDEO_HOSTS.some((host) => hostMatches(hostname, host))) {
      return "bilibili";
    }
    if (hostMatches(hostname, "v.douyin.com") || DOUYIN_HOSTS.some((host) => hostMatches(hostname, host))) {
      return "douyin";
    }
  }
  if (extractBvid(text) || /bilibili\.com|b23\.tv/i.test(text)) return "bilibili";
  if (extractDouyinAwemeId(text) || /douyin\.com|iesdouyin\.com|aweme/i.test(text)) return "douyin";
  return null;
}

export function detectPlatformFromLink(input?: string): Platform | "unknown" {
  return detectVideoPlatform(input) || "unknown";
}

export function getVideoComparableKey(input?: string) {
  const normalized = extractVideoUrl(input) || input?.trim() || "";
  if (!normalized) return "";

  const bvid = extractBvid(normalized);
  if (bvid) return `bilibili:${bvid.toUpperCase()}`;

  const douyinVideoId = extractDouyinAwemeId(normalized);
  if (douyinVideoId) return `douyin:${douyinVideoId}`;

  try {
    const parsed = new URL(withHttpScheme(normalized));
    const platform = detectVideoPlatform(normalized) || parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${platform}:${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    return normalized.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

export function extractBvid(input?: string) {
  if (!input) return "";
  return input.match(/BV[0-9A-Za-z]+/i)?.[0] || "";
}

export function extractBilibiliUid(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/space\.bilibili\.com\/(\d+)/);
  return match?.[1] ?? trimmed;
}

export function extractDouyinSecUid(input: string) {
  const trimmed = input.trim();
  const param = trimmed.match(/[?&]sec_uid=([^&]+)/);
  if (param?.[1]) return decodeURIComponent(param[1]);

  const path = trimmed.match(/\/user\/([^/?]+)/);
  return path?.[1] ? decodeURIComponent(path[1]) : trimmed;
}

export function extractDouyinAwemeId(input?: string) {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";

  if (/^\d{10,}$/.test(trimmed)) return trimmed;

  return (
    trimmed.match(/\/video\/(\d{10,})/i)?.[1] ||
    trimmed.match(/\/aweme\/share\/video\/(\d{10,})/i)?.[1] ||
    trimmed.match(/[?&](?:aweme_id|modal_id|item_id)=(\d{10,})/i)?.[1] ||
    trimmed.match(/(?:aweme_id|awemeId|modal_id|item_id)["'=:\s/]+(\d{10,})/i)?.[1] ||
    ""
  );
}

export function buildDouyinVideoUrl(awemeId?: string) {
  const normalized = extractDouyinAwemeId(awemeId);
  return normalized ? `https://www.douyin.com/video/${encodeURIComponent(normalized)}` : "";
}

export function browserUserAgent() {
  return BROWSER_USER_AGENT;
}

export function normalizeRemoteMediaUrl(input: string) {
  const cleaned = String(input || "")
    .trim()
    .replaceAll("\\/", "/")
    .split(/[\s|<>]/)[0]
    .replace(/,https?:\/\/.+$/i, "")
    .trim();
  return cleaned.startsWith("//") ? `https:${cleaned}` : cleaned;
}

export function normalizeRemoteImageUrl(input: string) {
  const normalized = normalizeRemoteMediaUrl(input);
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (isBilibiliImageHost(host)) {
      parsed.protocol = "https:";
      parsed.pathname = stripBilibiliImageResizeSuffix(parsed.pathname);
      if (/^\?imageView2\//i.test(parsed.search)) {
        parsed.search = "";
      } else {
        parsed.searchParams.delete("x-bce-process");
        parsed.searchParams.delete("x-image-process");
        parsed.searchParams.delete("imageView2");
      }
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return stripBilibiliImageResizeSuffix(normalized);
  }
}

export function isLikelyDirectMediaUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();

    if (/\.(mp4|m4a|mp3|wav|aac|flac|ogg|webm|mov|mkv)$/i.test(pathname)) return true;
    if (parsed.hostname.toLowerCase().includes("douyinvod.com")) return true;
    if (/^(video|audio)_/.test(mimeType)) return true;
    if (pathname.includes("/video/tos/")) return true;
  } catch {
    return /\.(mp4|m4a|mp3|wav|aac|flac|ogg|webm|mov|mkv)(\?|$)/i.test(url);
  }

  return false;
}

export function isSupportedRemoteMediaUrl(input: string) {
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();

    if (host === "data.bilibili.com" || path.includes("/log/")) return false;
    if (mimeType.startsWith("audio_") || mimeType.startsWith("video_")) return true;
    if (/douyinvod|bilivideo|akamaized/i.test(host)) return true;
    if (/\/aweme\/v1\/play\/|\/upgcxcode\//i.test(path)) return true;
    return /\.(m4s|mp4|m4a|mp3|aac|wav|flac|ogg|webm|mov)$/i.test(path);
  } catch {
    return false;
  }
}

export function isLikelyAudioMediaUrl(url: string) {
  try {
    const parsed = new URL(url);
    const text = `${parsed.pathname} ${parsed.search}`.toLowerCase();
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();
    return (
      mimeType.startsWith("audio_") ||
      /\.(m4a|mp3|aac|wav|flac|ogg)(\?|$)/i.test(parsed.pathname) ||
      /audio|30216|30232|30280|30250/.test(text)
    );
  } catch {
    return /\.(m4a|mp3|aac|wav|flac|ogg)(\?|$)/i.test(url) || /audio|30216|30232|30280|30250/i.test(url);
  }
}

export function sortRemoteAudioMediaUrls(urls: string[]) {
  const unique = [
    ...new Set(
      urls
        .map((url) => normalizeRemoteMediaUrl(url))
        .filter((url) => url && isSupportedRemoteMediaUrl(url))
    )
  ];
  return unique.sort((a, b) => audioMediaUrlScore(b) - audioMediaUrlScore(a));
}

export function selectRemoteVideoMediaUrl(urls: string[]) {
  const candidates = urls
    .map((url) => normalizeRemoteMediaUrl(url))
    .filter(Boolean)
    .filter((url) => !isLikelyAudioMediaUrl(url))
    .filter((url) => videoMediaUrlScore(url) > 0)
    .sort((a, b) => videoMediaUrlScore(b) - videoMediaUrlScore(a));
  return candidates[0] || "";
}

export function audioMediaUrlScore(url: string) {
  let score = 0;
  try {
    const parsed = new URL(url);
    const text = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase();
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();
    if (mimeType.startsWith("audio_")) score += 1000;
    if (/\.(m4a|mp3|aac|wav|flac|ogg)(\?|$)/i.test(parsed.pathname)) score += 900;
    if (/audio|30216|30232|30280|30250/.test(text)) score += 700;
    if (/douyinvod|audio|music|playwm|play_addr|download_addr/.test(text)) score += 160;
    if (/bilivideo|upgcxcode|mime_type=audio|\.m4s/.test(text)) score += 140;
    if (mimeType === "video_mp4" || /\.(mp4|webm|mov)(\?|$)/i.test(parsed.pathname)) score += 80;
  } catch {
    if (/\.(m4a|mp3|aac|wav|flac|ogg)(\?|$)/i.test(url)) score += 900;
    if (/audio|30216|30232|30280|30250/i.test(url)) score += 700;
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) score += 80;
  }
  return score;
}

export function videoMediaUrlScore(url: string) {
  try {
    const parsed = new URL(url);
    const text = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase();
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();
    let score = 0;
    if (mimeType.startsWith("video_")) score += 1000;
    if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(parsed.pathname)) score += 900;
    if (/douyinvod|play_addr|download_addr|mime_type=video|video_mp4/.test(text)) score += 700;
    if (/bilivideo|upgcxcode|mime_type=video|\.m4s/.test(text)) score += 300;
    return score;
  } catch {
    if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) return 900;
    if (/mime_type=video|video_mp4|douyinvod|bilivideo|upgcxcode/i.test(url)) return 700;
  }
  return 0;
}

export function buildRemoteAssetRequestHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": browserUserAgent(),
    Accept: "*/*"
  };
  if (/bilibili|bilivideo|akamaized|upgcxcode/i.test(url)) {
    headers.Referer = "https://www.bilibili.com/";
    headers.Origin = "https://www.bilibili.com";
  }
  if (/douyin|douyinvod/i.test(url)) {
    headers.Referer = "https://www.douyin.com/";
    headers.Origin = "https://www.douyin.com";
  }
  return headers;
}

export function inferRemoteFileExtension(url: string, family: RemoteAssetFamily) {
  try {
    const parsed = new URL(url);
    const pathName = parsed.pathname.toLowerCase();
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();
    const match = pathName.match(/\.(mp4|m4s|webm|mov|mkv|jpe?g|png|webp|gif)$/i);
    if (match?.[0]) return match[0].toLowerCase();
    if (mimeType.includes("webp")) return ".webp";
    if (mimeType.includes("png")) return ".png";
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
    if (mimeType.includes("webm")) return ".webm";
    if (mimeType.includes("video")) return ".mp4";
  } catch {
    const match = url.match(/\.(mp4|m4s|webm|mov|mkv|jpe?g|png|webp|gif)(?:\?|$)/i);
    if (match?.[0]) return match[0].replace(/\?$/, "").toLowerCase();
  }
  return family === "image" ? ".jpg" : ".mp4";
}

export function inferRemoteContentType(url: string, family: RemoteAssetFamily) {
  const extension = inferRemoteFileExtension(url, family);
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webm") return "video/webm";
  return family === "image" ? "image/jpeg" : "video/mp4";
}

function isBilibiliImageHost(host: string) {
  return /(?:^|\.)hdslb\.com$|(?:^|\.)biliimg\.com$/.test(host);
}

function stripBilibiliImageResizeSuffix(url: string) {
  return url.replace(/(\.(?:jpe?g|png|webp|gif))(?:@[^?#/]+)(?=([?#]|$))/i, "$1");
}

function collectPatternLinks(text: string, pattern: RegExp, options: LinkInputOptions, skipEmbeddedUrl = false) {
  return [...text.matchAll(pattern)]
    .filter((match) => !skipEmbeddedUrl || !isEmbeddedInExplicitUrl(text, match.index || 0))
    .map((match) => {
      const raw = trimLinkToken(match[0]);
      const url = normalizeLinkToken(raw);
      const start = match.index || 0;
      return {
        raw,
        url,
        start,
        end: start + raw.length
      };
    })
    .filter((link) => link.raw && link.url && isAllowedLink(link.url, options));
}

function trimLinkToken(token: string) {
  return token.replace(TRAILING_PUNCTUATION, "");
}

function isEmbeddedInExplicitUrl(text: string, start: number) {
  const prefix = text.slice(0, start);
  const tokenStart = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\t"),
    prefix.lastIndexOf("<"),
    prefix.lastIndexOf(">"),
    prefix.lastIndexOf("\""),
    prefix.lastIndexOf("'")
  ) + 1;
  return /^https?:\/\//i.test(prefix.slice(tokenStart));
}

function normalizeLinkToken(token: string) {
  const trimmed = trimLinkToken(token.trim());
  if (!trimmed) return "";
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return parseHttpUrl(candidate)?.href || "";
}

function isAllowedLink(url: string, options: LinkInputOptions) {
  if (options.kind === "video") return isVideoLink(url);
  if (options.kind === "account") return isAccountLink(url);
  return true;
}

function parseHttpUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function withHttpScheme(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function hostMatches(hostname: string, expected: string) {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}
