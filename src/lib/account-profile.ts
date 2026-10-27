import { buildOpenCliBrowserArgs, parseJsonish, runOpenCli, withSharedOpenCliBrowserSession } from "./opencli-runtime";
import { browserUserAgent, normalizeRemoteImageUrl } from "./platform-links";
import type { Platform, Video } from "./types";
import { shortHash } from "./utils";

type ResolveAccountProfileInput = {
  platform: Platform;
  uid: string;
  fallbackName: string;
  sourceUrl?: string;
  signal?: AbortSignal;
};

type AccountProfile = {
  name: string;
  avatarUrl: string;
  sourceUrl: string;
};

const DOUYIN_PROFILE_TIMEOUT_MS = 35_000;
const OPENCLI_DOCTOR_TIMEOUT_MS = 10_000;
const OPENCLI_BROWSER_DISCONNECTED_PATTERN = /Browser profile\s+"[^"]+"\s+is not connected|Extension not connected|Browser Bridge[^。.\n]*not connected|OpenCLI extension[^。.\n]*enabled/i;

export async function resolveAccountProfile(input: ResolveAccountProfileInput): Promise<AccountProfile> {
  const profile = input.platform === "bilibili"
    ? await fetchBilibiliAccountProfile(input)
    : await fetchDouyinAccountProfile(input);
  const name = cleanAccountNameCandidate(profile.name) || cleanAccountNameCandidate(input.fallbackName) || fallbackAccountName(input.platform, input.uid);
  const avatarUrl = normalizeRemoteImageUrl(profile.avatarUrl);

  if (!avatarUrl || !isAvatarImageUrl(avatarUrl)) {
    throw new Error(`${formatPlatform(input.platform)}账号「${name}」没有解析到头像，请确认主页可访问后重试。`);
  }

  return {
    name,
    avatarUrl,
    sourceUrl: profile.sourceUrl || input.sourceUrl || defaultAccountSourceUrl(input.platform, input.uid)
  };
}

export function inferAccountNameFromCollectedData(platform: Platform, raw: unknown, fallback: string) {
  const candidate = collectAuthorNameCandidates(raw)
    .map(cleanAccountNameCandidate)
    .find(Boolean);
  return candidate || cleanAccountNameCandidate(fallback) || fallbackAccountName(platform, fallback);
}

export function inferAccountAvatarFromCollectedData(videos: Video[], raw: unknown) {
  const candidates = [
    ...collectAvatarUrlCandidates(videos),
    ...collectAvatarUrlCandidates(raw)
  ];
  return candidates.map(normalizeRemoteImageUrl).find(isAvatarImageUrl) || "";
}

async function fetchBilibiliAccountProfile(input: ResolveAccountProfileInput) {
  const response = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(input.uid)}&photo=true`, {
    headers: {
      "User-Agent": browserUserAgent()
    },
    signal: input.signal
  });

  if (!response.ok) {
    throw new Error(`获取 B站账号资料失败：HTTP ${response.status}`);
  }

  const data = await response.json() as unknown;
  const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const code = Number(root.code ?? 0);
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(`获取 B站账号资料失败：${String(root.message || root.msg || `接口返回 ${code}`)}`);
  }

  const payload = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : {};
  const card = payload.card && typeof payload.card === "object" ? payload.card as Record<string, unknown> : {};
  return {
    name: String(card.name || input.fallbackName || ""),
    avatarUrl: String(card.face || ""),
    sourceUrl: defaultAccountSourceUrl("bilibili", input.uid)
  };
}

async function fetchDouyinAccountProfile(input: ResolveAccountProfileInput) {
  const profileUrl = defaultAccountSourceUrl("douyin", input.uid);

  return withSharedOpenCliBrowserSession(async (workspace) => {
    try {
      await openDouyinProfilePage(workspace, profileUrl, input.signal);
      await runOpenCli(buildOpenCliBrowserArgs(workspace, "wait", ["time", "2"]), {
        timeout: 10_000,
        signal: input.signal
      });
      const rawProfile = parseJsonish(await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [buildDouyinProfileExtractJs(input.uid)]), {
        timeout: DOUYIN_PROFILE_TIMEOUT_MS,
        signal: input.signal
      }));
      const profile = rawProfile && typeof rawProfile === "object" ? rawProfile as Record<string, unknown> : {};

      return {
        name: String(profile.name || profile.nickname || input.fallbackName || ""),
        avatarUrl: String(profile.avatarUrl || profile.avatar_url || ""),
        sourceUrl: String(profile.sourceUrl || profile.url || profileUrl)
      };
    } catch (error) {
      if (isAbortError(error, input.signal)) throw error;
      throw new Error(`获取抖音账号资料失败：${formatDouyinProfileError(error)}`);
    }
  }, { signal: input.signal });
}

async function openDouyinProfilePage(workspace: string, profileUrl: string, signal?: AbortSignal) {
  const openArgs = buildOpenCliBrowserArgs(workspace, "open", [profileUrl], { window: "background" });

  try {
    await runOpenCli(openArgs, {
      timeout: DOUYIN_PROFILE_TIMEOUT_MS,
      signal
    });
    return;
  } catch (error) {
    if (isAbortError(error, signal) || !isOpenCliBrowserDisconnectedError(error)) throw error;

    const doctorOutput = await runOpenCli(["doctor"], {
      timeout: OPENCLI_DOCTOR_TIMEOUT_MS,
      signal
    }).catch((doctorError) => {
      if (isAbortError(doctorError, signal)) throw doctorError;
      return formatErrorMessage(doctorError);
    });

    if (!isOpenCliDoctorBrowserConnected(doctorOutput)) {
      throw new Error(formatOpenCliBrowserDisconnectedError());
    }

    try {
      await runOpenCli(openArgs, {
        timeout: DOUYIN_PROFILE_TIMEOUT_MS,
        signal
      });
    } catch (retryError) {
      if (isAbortError(retryError, signal)) throw retryError;
      if (!isOpenCliBrowserDisconnectedError(retryError)) throw retryError;
      throw new Error(formatOpenCliBrowserDisconnectedError());
    }
  }
}

function buildDouyinProfileExtractJs(secUid: string) {
  return `
(async () => {
  const secUid = ${JSON.stringify(secUid)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const normalizeUrl = (url) => {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return location.origin + url;
    return url;
  };
  const firstUrl = (value) => {
    if (!value) return "";
    if (typeof value === "string") return normalizeUrl(value);
    if (Array.isArray(value)) return normalizeUrl(String(value[0] || ""));
    if (Array.isArray(value.url_list)) return normalizeUrl(String(value.url_list[0] || ""));
    return "";
  };
  const userFromPayload = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    return payload.user || payload.user_info || payload.userInfo || payload.user_profile || null;
  };
  const normalizeUser = (user) => {
    if (!user || typeof user !== "object") return null;
    const avatarUrl = firstUrl(user.avatar_thumb || user.avatar_medium || user.avatar_larger || user.avatar_url || user.avatarUrl);
    const name = clean(user.nickname || user.name || user.unique_id || user.short_id || "");
    return avatarUrl || name ? {
      name,
      nickname: name,
      avatar_url: avatarUrl,
      avatarUrl,
      sourceUrl: location.href
    } : null;
  };
  const fetchProfile = async () => {
    const url = new URL("/aweme/v1/web/user/profile/other/", location.origin);
    url.searchParams.set("sec_user_id", secUid);
    url.searchParams.set("aid", "6383");
    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*"
      }
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return normalizeUser(userFromPayload(payload));
  };
  const titleName = () => {
    const metaTitle = document.querySelector('meta[property="og:title"], meta[name="title"]')?.getAttribute("content") || "";
    return clean(metaTitle || document.title)
      .replace(/[-_｜|].*抖音.*$/i, "")
      .replace(/^@+/, "");
  };
  const imageScore = (image) => {
    const src = normalizeUrl(image.currentSrc || image.src || image.dataset?.src || image.getAttribute("src") || "");
    if (!/^https?:\\/\\//i.test(src)) return -1;
    const text = clean([src, image.alt, image.className, image.id].join(" ")).toLowerCase();
    if (/logo|emoji|sprite|qrcode|download/.test(text)) return -1;
    let score = /(avatar|head|user|face|douyinpic|byteimg|pstatp|tos-cn)/.test(text) ? 20 : 0;
    const rect = image.getBoundingClientRect();
    const width = image.naturalWidth || rect.width || image.width || 0;
    const height = image.naturalHeight || rect.height || image.height || 0;
    if (width >= 40 && height >= 40) score += 8;
    if (width && height) score -= Math.min(Math.abs(width - height) / Math.max(width, height) * 10, 8);
    return score;
  };
  const domProfile = () => {
    const images = Array.from(document.images)
      .map((image) => ({
        src: normalizeUrl(image.currentSrc || image.src || image.dataset?.src || image.getAttribute("src") || ""),
        score: imageScore(image)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    return {
      name: titleName(),
      nickname: titleName(),
      avatar_url: images[0]?.src || "",
      avatarUrl: images[0]?.src || "",
      sourceUrl: location.href
    };
  };

  for (let index = 0; index < 6; index += 1) {
    const apiProfile = await fetchProfile().catch(() => null);
    if (apiProfile?.avatarUrl) return apiProfile;

    const profile = domProfile();
    if (profile.avatarUrl) return profile;
    await sleep(1000);
  }

  return domProfile();
})()
`;
}

function collectAvatarUrlCandidates(value: unknown, depth = 0, keyHint = ""): string[] {
  if (!value || depth > 6) return [];

  if (typeof value === "string") {
    return isAvatarKeyHint(keyHint) ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.slice(0, 80).flatMap((item) => collectAvatarUrlCandidates(item, depth + 1, keyHint));
  }

  if (typeof value !== "object") return [];

  const object = value as Record<string, unknown>;
  const directKeys = [
    "avatar",
    "avatarUrl",
    "avatar_url",
    "avatarThumb",
    "avatar_thumb",
    "avatarMedium",
    "avatar_medium",
    "avatarLarger",
    "avatar_larger",
    "face",
    "faceUrl",
    "face_url",
    "headUrl",
    "head_url",
    "profileImageUrl",
    "profile_image_url"
  ];
  const nestedKeys = [
    "author",
    "owner",
    "user",
    "user_info",
    "account",
    "metadata",
    "raw",
    "data"
  ];
  const direct = directKeys.flatMap((key) => collectAvatarUrlCandidates(object[key], depth + 1, key));
  const nested = nestedKeys.flatMap((key) => collectAvatarUrlCandidates(object[key], depth + 1, key));
  return [...direct, ...nested];
}

function collectAuthorNameCandidates(value: unknown, depth = 0): string[] {
  if (!value || depth > 4) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) {
    return value.slice(0, 40).flatMap((item) => collectAuthorNameCandidates(item, depth + 1));
  }
  if (typeof value !== "object") return [];

  const object = value as Record<string, unknown>;
  const directKeys = [
    "authorName",
    "author_name",
    "ownerName",
    "owner_name",
    "nickname",
    "display_name",
    "userName",
    "user_name",
    "uname",
    "author",
    ...(depth > 1 ? ["name"] : [])
  ];
  const nestedKeys = ["metadata", "author", "owner", "user", "user_info", "account"];
  const direct = directKeys
    .map((key) => object[key])
    .filter((item): item is string => typeof item === "string");
  const nested = nestedKeys.flatMap((key) => collectAuthorNameCandidates(object[key], depth + 1));
  return [...direct, ...nested];
}

function cleanAccountNameCandidate(value: string) {
  const cleaned = value
    .replace(/\s*\((?:mid|uid)\s*:\s*\d+\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 60) return "";
  if (/^https?:\/\//i.test(cleaned) || cleaned.includes("/")) return "";
  if (/^MS4wLjAB[0-9A-Za-z_.-]{20,}$/.test(cleaned)) return "";
  if (cleaned === "未命名视频") return "";
  return cleaned;
}

function isAvatarKeyHint(keyHint: string) {
  return /avatar|face|head|profile.*image/i.test(keyHint);
}

function isAvatarImageUrl(value: string) {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const text = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase();
    return /(avatar|face|head|profile|user|bfs\/face|douyinpic|byteimg|pstatp|tos-cn)/.test(text);
  } catch {
    return false;
  }
}

function fallbackAccountName(platform: Platform, uidOrUrl: string) {
  return `${platform === "bilibili" ? "B站账号" : "抖音账号"} ${shortHash(uidOrUrl)}`;
}

function defaultAccountSourceUrl(platform: Platform, uid: string) {
  return platform === "bilibili"
    ? `https://space.bilibili.com/${encodeURIComponent(uid)}`
    : `https://www.douyin.com/user/${encodeURIComponent(uid)}`;
}

function formatPlatform(platform: Platform) {
  return platform === "bilibili" ? "B站" : "抖音";
}

function formatDouyinProfileError(error: unknown) {
  if (isOpenCliBrowserDisconnectedError(error)) {
    return formatOpenCliBrowserDisconnectedError();
  }

  const message = compactOpenCliError(formatErrorMessage(error));
  return message || "opencli 未返回头像";
}

function formatOpenCliBrowserDisconnectedError() {
  return "OpenCLI 浏览器配置未连接，无法打开抖音主页。请打开对应的 Chrome profile，并确认 OpenCLI 扩展已启用，然后重试；也可以运行 opencli doctor 查看连接状态。";
}

function isOpenCliBrowserDisconnectedError(error: unknown) {
  return OPENCLI_BROWSER_DISCONNECTED_PATTERN.test(formatErrorMessage(error));
}

function isOpenCliDoctorBrowserConnected(output: string) {
  return /(?:Extension|Browser Bridge)[^\n]*(?:connected|已连接)|:\s*connected\b/i.test(output);
}

function compactOpenCliError(message: string) {
  return message
    .replace(/^Command failed:[^\n]*(?:\n|$)/i, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[✖✔]\s*/, "").replace(/^Hint:\s*/i, "提示：").trim())
    .filter((line) => line && !/^Update available:/i.test(line) && !/^Run:/i.test(line) && !/^Download:/i.test(line))
    .join("；")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted) || (error instanceof Error && (error.name === "AbortError" || /aborted|任务已停止/i.test(error.message)));
}
