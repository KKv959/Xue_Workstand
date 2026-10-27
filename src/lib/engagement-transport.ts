export type EngagementTransportGuard = {
  blockedDomains: string[];
  blockedTokens: string[];
  hasTransportSource: boolean;
};

const URL_MATCH_PATTERN = /https?:\/\/[^\s<>"'）)]+/gi;
const URL_TEST_PATTERN = /https?:\/\/[^\s<>"'）)]+/i;
const PLATFORM_DOMAIN_PATTERN = /\b(?:v\.)?douyin\.com\b|\b(?:www\.)?bilibili\.com\b|\bb23\.tv\b/i;
const PLATFORM_DOMAIN_GLOBAL_PATTERN = /\b(?:v\.)?douyin\.com\b|\b(?:www\.)?bilibili\.com\b|\bb23\.tv\b/gi;
const SHARE_INSTRUCTION_PATTERNS = [
  /复制(?:此)?链接[，,]?\s*打开(?:抖音|Dou音|哔哩哔哩|B站)[^。！？!\n]{0,28}(?:观看视频|搜索)?[。！？!]*/gi,
  /打开(?:抖音|Dou音|哔哩哔哩|B站)搜索[，,]?\s*(?:直接)?观看视频[。！？!]*/gi,
  /长按复制(?:此)?条消息[^。！？!\n]{0,24}[。！？!]*/gi
];
const SHARE_PREFIX_PATTERN = /^\s*\d+(?:\.\d+)?\s+\d{1,2}\/\d{1,2}\s+.{0,52}?:\/\s*/;

export function buildEngagementTransportGuard(values: Array<string | undefined>, videoIds: string[] = []): EngagementTransportGuard {
  const blockedDomains = new Set<string>();
  const blockedTokens = new Set(videoIds.map((id) => id.toLowerCase()));
  let hasTransportSource = false;

  for (const value of values) {
    if (!value) continue;
    for (const token of value.match(/BV[0-9A-Za-z]{10}\b|\b\d{18,20}\b/gi) || []) blockedTokens.add(token.toLowerCase());
    const urls = value.match(URL_MATCH_PATTERN) || [];
    if (urls.length || PLATFORM_DOMAIN_PATTERN.test(value) || hasShareInstruction(value)) {
      hasTransportSource = true;
    }
    for (const rawUrl of urls) {
      try {
        const parsed = new URL(trimUrlPunctuation(rawUrl));
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (hostname) blockedDomains.add(hostname);
        for (const segment of parsed.pathname.split("/").map(decodeUrlSegment)) {
          if (isTransportToken(segment)) blockedTokens.add(segment.toLowerCase());
        }
        for (const key of ["modal_id", "aweme_id", "item_id", "bvid", "video_id"]) {
          const value = parsed.searchParams.get(key);
          if (value && isTransportToken(value)) blockedTokens.add(value.toLowerCase());
        }
      } catch {
        // A malformed URL is still removed by the text sanitizer and the direct URL leak check.
      }
    }
  }

  return {
    blockedDomains: [...blockedDomains],
    blockedTokens: [...blockedTokens],
    hasTransportSource
  };
}

export function sanitizeEngagementGenerationText(value: string, guard?: EngagementTransportGuard) {
  if (!value) return "";
  const hasShareEnvelope = URL_TEST_PATTERN.test(value) || PLATFORM_DOMAIN_PATTERN.test(value) || hasShareInstruction(value);
  let text = value
    .replace(URL_MATCH_PATTERN, " ")
    .replace(PLATFORM_DOMAIN_GLOBAL_PATTERN, " ");
  for (const pattern of SHARE_INSTRUCTION_PATTERNS) text = text.replace(pattern, " ");
  for (const token of [...(guard?.blockedTokens || []), ...(guard?.blockedDomains || [])]) {
    text = text.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  text = text.replace(/BV[0-9A-Za-z]{10}\b|\b\d{18,20}\b/gi, " ");
  if (hasShareEnvelope) text = text.replace(SHARE_PREFIX_PATTERN, "");
  return text
    .replace(/(?:^|\n)\s*原始输入[：:]?\s*(?=\n|$)/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function containsEngagementTransportLeak(value: string, guard: EngagementTransportGuard) {
  const normalized = value.toLowerCase();
  if (URL_TEST_PATTERN.test(value) || PLATFORM_DOMAIN_PATTERN.test(value)) return true;
  if (/BV[0-9A-Za-z]{10}\b|\b\d{18,20}\b/i.test(value)) return true;
  if (guard.blockedDomains.some((domain) => normalized.includes(domain))) return true;
  if (guard.blockedTokens.some((token) => normalized.includes(token))) return true;
  if (!guard.hasTransportSource) return false;
  return /(?:这|那|这种|那种|这个|那个|这条|那条|短)?链接(?:里|码|那段|点进去|一看)|网址|短链|复制链接|打开(?:抖音|Dou音|B站).*搜索/i.test(value);
}

function hasShareInstruction(value: string) {
  return SHARE_INSTRUCTION_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  });
}

function decodeUrlSegment(value: string) {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function isTransportToken(value: string) {
  if (value.length < 5 || value.length > 80) return false;
  if (/^\d{10,}$/.test(value)) return true;
  return /[A-Za-z]/.test(value) && (/\d/.test(value) || value.length >= 8);
}

function trimUrlPunctuation(value: string) {
  return value.replace(/[，。！？!；;、]+$/g, "");
}
