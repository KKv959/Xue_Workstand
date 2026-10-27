import path from "path";
import { libraryRoot } from "./storage/core";
import { storageFs as fs } from "./storage/fs";
import type { Platform } from "./types";

export const engagementCommentIntents = [
  "reaction",
  "question",
  "price",
  "comparison",
  "skeptical",
  "experience",
  "follow",
  "chatter"
] as const;

export type EngagementCommentIntent = (typeof engagementCommentIntents)[number];
export type EngagementStyleChannel = "douyin_comment" | "bilibili_comment" | "bilibili_danmaku";

export type EngagementStyleProfile = {
  channel: EngagementStyleChannel;
  source: "preset" | "local" | "local+source";
  sampleCount: number;
  sourceSampleCount: number;
  lengthBuckets: {
    short: number;
    medium: number;
    long: number;
  };
  lengthQuantiles: {
    p25: number;
    median: number;
    p75: number;
  };
  intentBuckets: Record<EngagementCommentIntent, number>;
  nativeEmoteRate: number;
  nativeEmotes: string[];
  questionRate: number;
  exclamationRate: number;
  examples: string[];
  benchmarkAccounts: string[];
  benchmarkSampleCount: number;
  matchedVideoCount: number;
  matchedTopics: string[];
  matchedContentTypes: string[];
  danmakuRhythm?: EngagementDanmakuRhythmProfile;
  referenceError?: string;
};

export type EngagementDanmakuRhythmProfile = {
  timedSampleCount: number;
  videoCount: number;
  densityByPosition: number[];
  sameSecondRate: number;
  repeatRate: number;
  burstShare: number;
};

type EngagementStyleSample = {
  text: string;
  accountName: string;
  videoTitle: string;
  likes: number;
  source: "library" | "benchmark" | "current";
  videoId?: string;
  topics?: string[];
  contentTypes?: string[];
  timeSec?: number;
  durationSec?: number;
};

type LocalStyleCorpus = Record<EngagementStyleChannel, EngagementStyleSample[]>;

const STYLE_CORPUS_CACHE_MS = 5 * 60_000;
const STYLE_CORPUS_LIMIT = 12_000;
const STYLE_SAMPLE_LIMIT = 240;
const STYLE_EXAMPLE_LIMIT = 18;
const STYLE_RELEVANCE_SCORE_FLOOR = 16;
const STYLE_MIN_PROFILE_SAMPLES = 48;
const BENCHMARK_CACHE_VERSION = 2;
const BENCHMARK_CACHE_FILE = "benchmark-comments.json";
const NATIVE_EMOTE_PATTERN = /\[[^\]\n]{1,12}\]/g;
const PICTOGRAPH_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const PICTOGRAPH_GLOBAL_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

const PRESET_EMOTES: Record<EngagementStyleChannel, string[]> = {
  douyin_comment: ["[捂脸]", "[流泪]", "[发呆]", "[看]", "[尬笑]", "[灵机一动]", "[泪奔]", "[赞]"],
  bilibili_comment: ["[doge]"],
  bilibili_danmaku: []
};

const PRESET_EMOTE_RATES: Record<EngagementStyleChannel, number> = {
  douyin_comment: 0.24,
  bilibili_comment: 0.08,
  bilibili_danmaku: 0.02
};

const PRESET_LENGTHS: Record<EngagementStyleChannel, EngagementStyleProfile["lengthQuantiles"]> = {
  douyin_comment: { p25: 9, median: 17, p75: 30 },
  bilibili_comment: { p25: 10, median: 20, p75: 38 },
  bilibili_danmaku: { p25: 7, median: 13, p75: 21 }
};

let corpusCache: { expiresAt: number; value: LocalStyleCorpus } | null = null;

export function commentStyleChannel(platform: Platform | "unknown"): Extract<EngagementStyleChannel, `${string}_comment`> {
  return platform === "bilibili" ? "bilibili_comment" : "douyin_comment";
}

export async function loadEngagementStyleProfile(
  channel: EngagementStyleChannel,
  sourceSamples: string[] = [],
  referenceError?: string,
  contextText = "",
  excludeVideoIds: string[] = []
): Promise<EngagementStyleProfile> {
  const corpus = await loadLocalStyleCorpus();
  const normalizedSourceSamples = normalizeSamples(sourceSamples, channel).map((text): EngagementStyleSample => ({
    text,
    accountName: "当前来源",
    videoTitle: "",
    likes: 0,
    source: "current"
  }));
  const localSamples = selectRelevantStyleSamples(
    corpus[channel],
    contextText,
    Math.max(STYLE_SAMPLE_LIMIT - normalizedSourceSamples.length, 0),
    excludeVideoIds
  );
  const selectedSamples = uniqueStyleSamples([...normalizedSourceSamples, ...localSamples]).slice(0, STYLE_SAMPLE_LIMIT);
  const samples = selectedSamples.map((sample) => sample.text);
  const source = normalizedSourceSamples.length
    ? "local+source" as const
    : localSamples.length
      ? "local" as const
      : "preset" as const;
  const measured = samples.length ? buildMeasuredProfile(channel, samples) : null;

  return {
    channel,
    source,
    sampleCount: samples.length,
    sourceSampleCount: normalizedSourceSamples.length,
    lengthBuckets: measured?.lengthBuckets || presetLengthBuckets(channel),
    lengthQuantiles: measured?.lengthQuantiles || PRESET_LENGTHS[channel],
    intentBuckets: measured?.intentBuckets || presetIntentBuckets(channel),
    nativeEmoteRate: measured
      ? clampRate(measured.nativeEmoteRate, channel === "douyin_comment" ? 0.08 : 0, channel === "douyin_comment" ? 0.34 : 0.3)
      : PRESET_EMOTE_RATES[channel],
    nativeEmotes: uniqueText([
      ...(measured?.nativeEmotes || []),
      ...PRESET_EMOTES[channel]
    ]).slice(0, 16),
    questionRate: measured ? measured.questionRate : channel === "bilibili_danmaku" ? 0.08 : 0.14,
    exclamationRate: measured ? measured.exclamationRate : channel === "douyin_comment" ? 0.12 : 0.08,
    examples: selectRepresentativeExamples(samples, channel),
    benchmarkAccounts: uniqueText(
      selectedSamples
        .filter((sample) => sample.source === "benchmark")
        .map((sample) => sample.accountName)
    ),
    benchmarkSampleCount: selectedSamples.filter((sample) => sample.source === "benchmark").length,
    matchedVideoCount: new Set(selectedSamples.map((sample) => sample.videoId).filter(Boolean)).size,
    matchedTopics: summarizeMatchedMetadata(selectedSamples, "topics", contextText),
    matchedContentTypes: summarizeMatchedMetadata(selectedSamples, "contentTypes", contextText),
    danmakuRhythm: channel === "bilibili_danmaku" ? buildDanmakuRhythmProfile(selectedSamples) : undefined,
    referenceError
  };
}

export function buildPresetEngagementStyleProfile(channel: EngagementStyleChannel): EngagementStyleProfile {
  return {
    channel,
    source: "preset",
    sampleCount: 0,
    sourceSampleCount: 0,
    lengthBuckets: presetLengthBuckets(channel),
    lengthQuantiles: PRESET_LENGTHS[channel],
    intentBuckets: presetIntentBuckets(channel),
    nativeEmoteRate: PRESET_EMOTE_RATES[channel],
    nativeEmotes: PRESET_EMOTES[channel],
    questionRate: channel === "bilibili_danmaku" ? 0.08 : 0.14,
    exclamationRate: channel === "douyin_comment" ? 0.12 : 0.08,
    examples: [],
    benchmarkAccounts: [],
    benchmarkSampleCount: 0,
    matchedVideoCount: 0,
    matchedTopics: [],
    matchedContentTypes: []
  };
}

export function extractNativeEmotes(value: string) {
  return [
    ...(value.match(NATIVE_EMOTE_PATTERN) || []),
    ...(value.match(PICTOGRAPH_GLOBAL_PATTERN) || [])
  ];
}

export function hasNativeEmote(value: string) {
  return extractNativeEmotes(value).length > 0 || PICTOGRAPH_PATTERN.test(value);
}

export function findUnsupportedNativeEmotes(value: string, profile: EngagementStyleProfile) {
  const allowed = new Set(profile.nativeEmotes);
  return uniqueText(extractNativeEmotes(value).filter((emote) => !allowed.has(emote)));
}

export function formatEngagementStyleProfile(profile: EngagementStyleProfile) {
  const channelLabel = profile.channel === "douyin_comment"
    ? "抖音评论"
    : profile.channel === "bilibili_comment"
      ? "B站评论"
      : "B站弹幕";
  const totalLengths = Math.max(
    profile.lengthBuckets.short + profile.lengthBuckets.medium + profile.lengthBuckets.long,
    1
  );
  const percent = (value: number) => Math.round((value / totalLengths) * 100);
  return [
    `渠道：${channelLabel}`,
    `真实样本：${profile.sampleCount} 条（当前来源 ${profile.sourceSampleCount} 条）`,
    profile.benchmarkAccounts.length
      ? `标杆账号：${profile.benchmarkAccounts.join("、")}（只学习长度、节奏和互动方式，不照抄原句）`
      : "标杆账号：本次未命中本地标杆缓存",
    `题材命中：${profile.matchedTopics.join("、") || "通用"}；视频形态：${profile.matchedContentTypes.join("、") || "通用"}；覆盖 ${profile.matchedVideoCount} 个参考视频`,
    `长度：四分位 ${profile.lengthQuantiles.p25}/${profile.lengthQuantiles.median}/${profile.lengthQuantiles.p75} 字；短/中/长约 ${percent(profile.lengthBuckets.short)}%/${percent(profile.lengthBuckets.medium)}%/${percent(profile.lengthBuckets.long)}%`,
    `问句约 ${Math.round(profile.questionRate * 100)}%，感叹约 ${Math.round(profile.exclamationRate * 100)}%`,
    `平台表情约 ${Math.round(profile.nativeEmoteRate * 100)}%；允许表情：${profile.nativeEmotes.join(" ") || "不主动使用"}`,
    channelStyleNotes(profile.channel)
  ].join("\n");
}

export function classifyEngagementCommentIntent(value: string): EngagementCommentIntent {
  const text = value.trim();
  if (/^(?:cy|蹲|插眼|同问|码住|先收藏)/i.test(text) || /求链接|求个链接|有人买过吗|蹲反馈|蹲一个/.test(text)) return "follow";
  if (/圈里|圈内|吹水|热榜|热点|风向|卷成|卷到|卷麻|考古|前排|课代表/.test(text)) return "chatter";
  if (/对比|相比|比起来|和.+比|vs|VS|还是|哪个|哪把|怎么选|选.+还是/.test(text)) return "comparison";
  if (/价|到手|券|618|京东|便宜|贵|预算|优惠|直降|多少钱/.test(text)) return "price";
  if (/怕|担心|翻车|不稳|鸡肋|套路|观望|尴尬|靠谱吗|稳不稳|会不会/.test(text)) return "skeptical";
  if (/[?？]|(?:吗|嘛|呢)$|有没有|咋|怎么|什么|为什么|多少|哪(?:个|款|种|里|儿)?/.test(text)) return "question";
  if (/我(?:用过|买过|玩过|现在用|之前用|之前买|从小|当年|平时会|日常会)|宿舍|办公室|桌面党|打游戏|码字|学生党|舍友|用过|买过|现在用/.test(text)) return "experience";
  return "reaction";
}

async function loadLocalStyleCorpus() {
  if (corpusCache && corpusCache.expiresAt > Date.now()) return corpusCache.value;
  const root = libraryRoot();
  const value: LocalStyleCorpus = {
    douyin_comment: [],
    bilibili_comment: [],
    bilibili_danmaku: []
  };
  await collectJsonSamples(path.join(root, "douyin"), "douyin", value);
  await collectJsonSamples(path.join(root, "bilibili"), "bilibili", value);
  await collectJsonSamples(path.join(root, "douyin-hotlist", "accounts"), "unknown", value);
  await collectBenchmarkSamples(root, value);
  for (const channel of Object.keys(value) as EngagementStyleChannel[]) {
    value[channel] = uniqueStyleSamples(value[channel]).slice(0, STYLE_CORPUS_LIMIT);
  }
  corpusCache = { expiresAt: Date.now() + STYLE_CORPUS_CACHE_MS, value };
  return value;
}

async function collectJsonSamples(
  target: string,
  fallbackPlatform: Platform | "unknown",
  corpus: LocalStyleCorpus
) {
  const entries = await fs.readdirEntries(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw new Error(`读取互动风格样本目录失败：${target}。${error.message}`);
  });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await collectJsonSamples(entryPath, fallbackPlatform, corpus);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json") || !entryPath.includes(`${path.sep}videos${path.sep}`)) continue;
    const raw = await fs.readFile(entryPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw new Error(`读取互动风格样本失败：${entryPath}。${error.message}`);
    });
    if (!raw) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`互动风格样本 JSON 损坏：${entryPath}。${error instanceof Error ? error.message : "无法解析"}`);
    }
    const platform = parsed.platform === "bilibili" || parsed.platform === "douyin" ? parsed.platform : fallbackPlatform;
    const accountName = path.basename(path.dirname(path.dirname(entryPath)));
    const videoTitle = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const videoId = typeof parsed.id === "string" ? parsed.id.trim() : path.basename(entry.name, ".json");
    const topics = inferStyleTopics(videoTitle);
    const contentTypes = inferStyleContentTypes(videoTitle);
    const durationSec = parseDurationSec(parsed.duration);
    const videoLikes = readNumericValue(parsed.stats, "likes");
    if (platform === "bilibili" || platform === "douyin") {
      const comments = Array.isArray(parsed.topComments) ? parsed.topComments : [];
      for (const item of comments) {
        const sample = normalizeStyleSample(item, {
          accountName,
          videoTitle,
          likes: videoLikes,
          source: "library",
          videoId,
          topics,
          contentTypes
        });
        if (sample) corpus[`${platform}_comment`].push(sample);
      }
    }
    if (platform === "bilibili") {
      const danmaku = Array.isArray(parsed.danmakuSamples) ? parsed.danmakuSamples : [];
      for (const item of danmaku) {
        const sample = normalizeStyleSample(item, {
          accountName,
          videoTitle,
          likes: 0,
          source: "library",
          videoId,
          topics,
          contentTypes,
          durationSec
        });
        if (sample) corpus.bilibili_danmaku.push(sample);
      }
    }
  }
}

async function collectBenchmarkSamples(root: string, corpus: LocalStyleCorpus) {
  const cachePath = path.join(root, "engagement", ".cache", "style", BENCHMARK_CACHE_FILE);
  const raw = await fs.readFile(cachePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw new Error(`读取评论标杆语料缓存失败：${cachePath}。${error.message}`);
  });
  if (!raw) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`评论标杆语料缓存 JSON 损坏：${cachePath}。${error instanceof Error ? error.message : "无法解析"}`);
  }
  if (parsed.version !== BENCHMARK_CACHE_VERSION || !Array.isArray(parsed.samples)) {
    throw new Error(`评论标杆语料缓存版本不兼容：${cachePath}。请运行 npm run engagement:refresh-style 重新生成。`);
  }
  for (const item of parsed.samples) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const platform = row.platform === "bilibili" ? "bilibili" : "douyin";
    const channel = row.channel === "bilibili_danmaku"
      ? "bilibili_danmaku"
      : row.channel === "bilibili_comment"
        ? "bilibili_comment"
        : "douyin_comment";
    const videoTitle = typeof row.videoTitle === "string" ? row.videoTitle : "";
    if (platform === "bilibili" && isBilibiliBenchmarkVideoNoise(videoTitle)) continue;
    const sample = normalizeStyleSample(row, {
      accountName: typeof row.accountName === "string" ? row.accountName : "标杆账号",
      videoTitle,
      likes: readNumericValue(row, "likes"),
      source: "benchmark",
      videoId: typeof row.videoId === "string" ? row.videoId : undefined,
      topics: stringArray(row.topics),
      contentTypes: stringArray(row.contentTypes),
      timeSec: readOptionalNumber(row, "timeSec"),
      durationSec: readOptionalNumber(row, "durationSec")
    });
    if (sample && channel === "bilibili_comment" && isBilibiliBenchmarkCommentNoise(sample.text)) continue;
    if (sample && (channel !== "bilibili_danmaku" || platform === "bilibili")) corpus[channel].push(sample);
  }
}

function isBilibiliBenchmarkVideoNoise(value: string) {
  const markers = [
    /闭眼入/,
    /不踩(?:坑|雷)/,
    /建议收藏/,
    /保姆级/,
    /全价位/,
    /年度大合集/,
    /\d{4}年\d{1,2}月/,
    /最新.*(?:推荐|合集|测评)/,
    /(?:学生党|小白).*(?:必看|推荐|选购)/
  ];
  return markers.filter((pattern) => pattern.test(value)).length >= 2;
}

function isBilibiliBenchmarkCommentNoise(value: string) {
  return /(?:抽奖|开奖|中奖|欧气|读到这条).{0,16}(?:中奖|好运|欧气|抽|送)/i.test(value)
    || /(?:三连|关注|点赞|投币).{0,16}(?:抽|送|中奖|福利)/i.test(value)
    || /(?:抽|送)\s*\d{1,4}\s*(?:台|部|个|份|套).{0,18}(?:iphone|手机|耳机|奖|福利)?/i.test(value)
    || /(?:咱|本)(?:店|直播间)|店里逛逛|点击购买|购买链接|联系客服/i.test(value);
}

function normalizeStyleSample(
  value: unknown,
  fallback: Omit<EngagementStyleSample, "text">
): EngagementStyleSample | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const rawText = typeof value === "string"
    ? value
    : row && typeof row.text === "string"
      ? row.text
      : row && typeof row.content === "string"
        ? row.content
        : row && typeof row.comment === "string"
          ? row.comment
          : "";
  const text = rawText.replace(/\s+/g, " ").trim();
  if (Array.from(text).length < 2 || Array.from(text).length > 140) return null;
  return {
    text,
    accountName: fallback.accountName,
    videoTitle: fallback.videoTitle,
    likes: row ? Math.max(fallback.likes, readNumericValue(row, "likes"), readNumericValue(row, "digg_count")) : fallback.likes,
    source: fallback.source,
    videoId: row && typeof row.videoId === "string" ? row.videoId : fallback.videoId,
    topics: row && stringArray(row.topics).length ? stringArray(row.topics) : fallback.topics,
    contentTypes: row && stringArray(row.contentTypes).length ? stringArray(row.contentTypes) : fallback.contentTypes,
    timeSec: row ? readOptionalNumber(row, "timeSec") ?? fallback.timeSec : fallback.timeSec,
    durationSec: row ? readOptionalNumber(row, "durationSec") ?? fallback.durationSec : fallback.durationSec
  };
}

function readOptionalNumber(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  const numeric = typeof raw === "number" ? raw : Number.parseFloat(String(raw || ""));
  return Number.isFinite(numeric) ? numeric : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? uniqueText(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function readNumericValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return 0;
  const raw = (value as Record<string, unknown>)[key];
  const numeric = typeof raw === "number" ? raw : Number.parseFloat(String(raw || ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function selectRelevantStyleSamples(
  samples: EngagementStyleSample[],
  contextText: string,
  limit: number,
  excludeVideoIds: string[]
) {
  if (!samples.length || limit <= 0) return [];
  const excluded = new Set(excludeVideoIds.map(normalizeVideoId).filter(Boolean));
  const tokens = styleContextTokens(contextText);
  const contextTopics = inferStyleTopics(contextText).filter((topic) => topic !== "general");
  const contextContentTypes = inferStyleContentTypes(contextText).filter((type) => type !== "general");
  const scored = samples
    .filter((sample) => !sample.videoId || !excluded.has(normalizeVideoId(sample.videoId)))
    .map((sample, index) => ({
      sample,
      index,
      score: scoreStyleSample(sample, tokens, contextTopics, contextContentTypes)
    }))
    .sort((left, right) => right.score - left.score || right.sample.likes - left.sample.likes || left.index - right.index);
  const groups = new Map<string, typeof scored>();
  for (const item of scored) {
    const key = `${item.sample.source}:${item.sample.videoId || item.sample.accountName || "未知来源"}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((left, right) =>
    (right[0]?.score || 0) - (left[0]?.score || 0)
  );
  const hasContextSignal = tokens.length > 0 || contextTopics.length > 0 || contextContentTypes.length > 0;
  const titleRelevantGroups = orderedGroups.filter((group) => group.some(({ sample }) => {
    const title = sample.videoTitle.toLowerCase();
    return tokens.some((token) => title.includes(token));
  }));
  const metadataRelevantGroups = orderedGroups.filter((group) => group.some(({ sample }) =>
    contextTopics.some((topic) => sample.topics?.includes(topic))
    || contextContentTypes.some((type) => sample.contentTypes?.includes(type))
  ));
  const relevanceCandidates = titleRelevantGroups.length
    ? titleRelevantGroups
    : metadataRelevantGroups.length
      ? metadataRelevantGroups
      : orderedGroups;
  const bestRelevanceScore = relevanceCandidates[0]?.[0]?.score || 0;
  const focusedRelevanceFloor = Math.max(STYLE_RELEVANCE_SCORE_FLOOR, bestRelevanceScore - 30);
  const relevantGroups = hasContextSignal
    ? relevanceCandidates.filter((group) => (group[0]?.score || 0) >= focusedRelevanceFloor)
    : orderedGroups;
  if (!relevantGroups.length) return takeStyleSamplesRoundRobin(orderedGroups, limit);

  const relevant = takeStyleSamplesRoundRobin(relevantGroups, limit);
  if (relevant.length >= Math.min(limit, STYLE_MIN_PROFILE_SAMPLES)) return relevant;

  const selectedGroupKeys = new Set(relevantGroups.map(styleSampleGroupKey));
  const secondaryGroups = metadataRelevantGroups.filter((group) => !selectedGroupKeys.has(styleSampleGroupKey(group)));
  const secondary = takeStyleSamplesRoundRobin(
    secondaryGroups,
    Math.min(limit - relevant.length, Math.max(STYLE_MIN_PROFILE_SAMPLES - relevant.length, 0))
  );
  secondaryGroups.forEach((group) => selectedGroupKeys.add(styleSampleGroupKey(group)));
  const focused = uniqueStyleSamples([...relevant, ...secondary]);
  if (focused.length >= Math.min(limit, STYLE_MIN_PROFILE_SAMPLES)) return focused.slice(0, limit);

  const fallbackGroups = orderedGroups.filter((group) => {
    return !selectedGroupKeys.has(styleSampleGroupKey(group));
  });
  const fallbackLimit = Math.min(
    limit - focused.length,
    Math.max(STYLE_MIN_PROFILE_SAMPLES - focused.length, 0)
  );
  return uniqueStyleSamples([
    ...focused,
    ...takeStyleSamplesRoundRobin(fallbackGroups, fallbackLimit)
  ]).slice(0, limit);
}

function styleSampleGroupKey(group: Array<{ sample: EngagementStyleSample }>) {
  const sample = group[0]?.sample;
  return `${sample?.source || "unknown"}:${sample?.videoId || sample?.accountName || ""}`;
}

function takeStyleSamplesRoundRobin(
  groups: Array<Array<{ sample: EngagementStyleSample }>>,
  limit: number
) {
  const output: EngagementStyleSample[] = [];
  let row = 0;
  while (output.length < limit) {
    let appended = false;
    for (const group of groups) {
      const item = group[row];
      if (!item) continue;
      output.push(item.sample);
      appended = true;
      if (output.length >= limit) break;
    }
    if (!appended) break;
    row += 1;
  }
  return output;
}

function scoreStyleSample(
  sample: EngagementStyleSample,
  tokens: string[],
  contextTopics: string[],
  contextContentTypes: string[]
) {
  const title = sample.videoTitle.toLowerCase();
  const text = sample.text.toLowerCase();
  const titleMatches = tokens.filter((token) => title.includes(token)).length;
  const textMatches = tokens.filter((token) => text.includes(token)).length;
  const topicMatches = contextTopics.filter((topic) => sample.topics?.includes(topic)).length;
  const contentTypeMatches = contextContentTypes.filter((type) => sample.contentTypes?.includes(type)).length;
  return topicMatches * 36
    + contentTypeMatches * 18
    + titleMatches * 16
    + textMatches * 3
    + (sample.source === "benchmark" ? 2 : 0)
    + Math.min(6, Math.log10(Math.max(1, sample.likes) + 1));
}

function summarizeMatchedMetadata(
  samples: EngagementStyleSample[],
  key: "topics" | "contentTypes",
  contextText: string
) {
  const contextValues = key === "topics" ? inferStyleTopics(contextText) : inferStyleContentTypes(contextText);
  const counts = new Map<string, number>();
  for (const sample of samples) {
    for (const value of sample[key] || []) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => {
      const leftContext = contextValues.includes(left[0]) ? 1 : 0;
      const rightContext = contextValues.includes(right[0]) ? 1 : 0;
      return rightContext - leftContext || right[1] - left[1] || left[0].localeCompare(right[0]);
    })
    .slice(0, 4)
    .map(([value]) => value);
}

function buildDanmakuRhythmProfile(samples: EngagementStyleSample[]): EngagementDanmakuRhythmProfile {
  const timed = samples.filter((sample) =>
    typeof sample.timeSec === "number" && typeof sample.durationSec === "number" && sample.durationSec > 0
  );
  const binCount = 20;
  const densityByPosition = Array.from({ length: binCount }, () => 0);
  const videoGroups = new Map<string, EngagementStyleSample[]>();
  for (const sample of timed) {
    const key = sample.videoId || "unknown";
    const group = videoGroups.get(key) || [];
    group.push(sample);
    videoGroups.set(key, group);
  }
  let sameSecondCount = 0;
  let repeatedCount = 0;
  let burstCount = 0;
  for (const group of videoGroups.values()) {
    const bins = Array.from({ length: binCount }, () => 0);
    const seconds = new Map<number, number>();
    const texts = new Map<string, number>();
    for (const sample of group) {
      const duration = Math.max(sample.durationSec || 1, 1);
      const position = Math.min(0.999, Math.max(0, (sample.timeSec || 0) / duration));
      bins[Math.min(binCount - 1, Math.floor(position * binCount))] += 1;
      const second = Math.round(sample.timeSec || 0);
      seconds.set(second, (seconds.get(second) || 0) + 1);
      const fingerprint = styleSampleFingerprint(sample.text);
      texts.set(fingerprint, (texts.get(fingerprint) || 0) + 1);
    }
    const total = Math.max(group.length, 1);
    bins.forEach((count, index) => {
      densityByPosition[index] += count / total;
    });
    sameSecondCount += [...seconds.values()].reduce((sum, count) => sum + Math.max(count - 1, 0), 0);
    repeatedCount += [...texts.values()].reduce((sum, count) => sum + Math.max(count - 1, 0), 0);
    const topBins = [...bins].sort((left, right) => right - left).slice(0, 4);
    burstCount += topBins.reduce((sum, count) => sum + count, 0);
  }
  const densityTotal = densityByPosition.reduce((sum, value) => sum + value, 0) || 1;
  return {
    timedSampleCount: timed.length,
    videoCount: videoGroups.size,
    densityByPosition: densityByPosition.map((value) => value / densityTotal),
    sameSecondRate: timed.length ? sameSecondCount / timed.length : 0.12,
    repeatRate: timed.length ? repeatedCount / timed.length : 0.08,
    burstShare: timed.length ? burstCount / timed.length : 0.55
  };
}

function inferStyleTopics(value: string) {
  const text = String(value || "").toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["digital_ai", /ai|人工智能|数码|手机|电脑|硬件|软件|键盘|鼠标|耳机|相机|摄像头|机器人|效率工具|工作流|app|芯片/],
    ["gaming", /游戏|玩家|电竞|steam|主机|手游|版本|角色|地图|副本|cs2|英雄联盟|原神/],
    ["workplace", /职场|上班|打工|办公|会议|同事|老板|简历|工作|效率|副业/],
    ["food", /美食|餐厅|小吃|料理|做饭|探店|咖啡|饮料/],
    ["auto", /汽车|新车|试驾|车主|续航|智驾|油耗|电车|suv/],
    ["home", /家居|装修|收纳|家具|家电|清洁|租房|好物/],
    ["beauty", /美妆|护肤|口红|粉底|穿搭|发型|香水/],
    ["education", /学习|课程|考试|大学|知识|科普|教程|英语|数学/],
    ["entertainment", /电影|电视剧|综艺|明星|动画|动漫|音乐|演唱会/],
    ["social_news", /新闻|热点|社会|国际|网友|事件|政策|舆论/],
    ["lifestyle", /生活|旅行|日常|vlog|情侣|家庭|宠物|健康|运动/]
  ];
  const topics = rules.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
  return topics.length ? topics : ["general"];
}

function inferStyleContentTypes(value: string) {
  const text = String(value || "").toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["review", /测评|评测|体验|上手|值不值|对比|开箱|实测/],
    ["commercial", /商单|合作|优惠|新品|首发|到手|购买|品牌|限时|推荐/],
    ["tutorial", /教程|怎么|指南|技巧|入门|教学|实战/],
    ["news", /新闻|热点|速报|发布|官宣|事件|回应/],
    ["story", /故事|记录|一天|经历|挑战|vlog/],
    ["discussion", /如何看|聊聊|为什么|到底|争议|吐槽/]
  ];
  const types = rules.filter(([, pattern]) => pattern.test(text)).map(([type]) => type);
  return types.length ? types : ["general"];
}

function parseDurationSec(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number.parseFloat(text);
  const parts = text.split(":").map((part) => Number.parseFloat(part));
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  const seconds = text.match(/\((\d+)s\)/i);
  return seconds ? Number.parseInt(seconds[1], 10) : undefined;
}

function normalizeVideoId(value: string) {
  const raw = String(value || "");
  return raw.match(/BV[0-9A-Za-z]{10}/i)?.[0]?.toLowerCase()
    || raw.match(/(?:video\/|modal_id=)(\d{8,})/i)?.[1]
    || raw.trim().toLowerCase();
}

function styleSampleFingerprint(value: string) {
  return value.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "").toLowerCase();
}

function styleContextTokens(value: string) {
  const normalized = String(value || "").toLowerCase();
  const words = normalized.match(/[a-z0-9][a-z0-9.+-]{1,24}|[\u4e00-\u9fa5]{2,12}/g) || [];
  const tokens = words.flatMap((word) => {
    if (!/[\u4e00-\u9fa5]/.test(word) || word.length <= 3) return [word];
    if (word.length <= 6) {
      return [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))];
    }
    return [word];
  });
  return uniqueText(tokens)
    .filter((token) => !/^\d+(?:\.\d+)?$/.test(token))
    .filter((token) => !/^(这个|那个|视频|评论|大家|一个|我们|你们|他们|就是|真的|可以|感觉|怎么|什么|为什么|还是|比较|现在)$/.test(token))
    .slice(0, 80);
}

function buildMeasuredProfile(channel: EngagementStyleChannel, samples: string[]) {
  const lengths = samples.map((sample) => Array.from(sample).length).sort((left, right) => left - right);
  const shortMax = channel === "bilibili_danmaku" ? 8 : 12;
  const mediumMax = channel === "bilibili_danmaku" ? 22 : 35;
  const lengthBuckets = samples.reduce(
    (buckets, sample) => {
      const length = Array.from(sample).length;
      if (length <= shortMax) buckets.short += 1;
      else if (length <= mediumMax) buckets.medium += 1;
      else buckets.long += 1;
      return buckets;
    },
    { short: 0, medium: 0, long: 0 }
  );
  const intentBuckets = samples.reduce((buckets, sample) => {
    buckets[classifyEngagementCommentIntent(sample)] += 1;
    return buckets;
  }, emptyIntentBuckets());
  const emoteCounts = new Map<string, number>();
  for (const sample of samples) {
    for (const emote of extractNativeEmotes(sample)) {
      emoteCounts.set(emote, (emoteCounts.get(emote) || 0) + 1);
    }
  }
  return {
    lengthBuckets,
    lengthQuantiles: {
      p25: quantile(lengths, 0.25),
      median: quantile(lengths, 0.5),
      p75: quantile(lengths, 0.75)
    },
    intentBuckets,
    nativeEmoteRate: samples.filter(hasNativeEmote).length / samples.length,
    nativeEmotes: [...emoteCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([emote]) => emote),
    questionRate: samples.filter((sample) => /[?？]/.test(sample)).length / samples.length,
    exclamationRate: samples.filter((sample) => /[!！]/.test(sample)).length / samples.length
  };
}

function selectRepresentativeExamples(samples: string[], channel: EngagementStyleChannel) {
  if (!samples.length) return [];
  const maxLength = channel === "bilibili_danmaku" ? 42 : 90;
  const candidates = samples.filter((sample) => Array.from(sample).length <= maxLength);
  const groups = [
    candidates.filter((sample) => Array.from(sample).length <= 10 && !hasNativeEmote(sample)),
    candidates.filter((sample) => {
      const length = Array.from(sample).length;
      return length >= 11 && length <= 35 && !/[?？]/.test(sample) && !hasNativeEmote(sample);
    }),
    candidates.filter((sample) => /[?？]/.test(sample)),
    candidates.filter((sample) => Array.from(sample).length >= 36),
    candidates.filter((sample) => hasNativeEmote(sample)),
    candidates.filter((sample) => !hasNativeEmote(sample)),
    candidates
  ];
  const output: string[] = [];
  const positions = groups.map(() => 0);
  while (output.length < STYLE_EXAMPLE_LIMIT) {
    let appended = false;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      while (positions[groupIndex] < group.length) {
        const sample = group[positions[groupIndex]];
        positions[groupIndex] += 1;
        if (output.includes(sample)) continue;
        output.push(sample);
        appended = true;
        break;
      }
      if (output.length >= STYLE_EXAMPLE_LIMIT) break;
    }
    if (!appended) break;
  }
  return output;
}

function normalizeSamples(samples: string[], channel: EngagementStyleChannel) {
  const maxLength = channel === "bilibili_danmaku" ? 60 : 140;
  return uniqueText(
    samples
      .map((sample) => String(sample || "").replace(/\s+/g, " ").trim())
      .filter((sample) => Array.from(sample).length >= 2 && Array.from(sample).length <= maxLength)
  ).slice(0, 120);
}

function uniqueText(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function uniqueStyleSamples(values: EngagementStyleSample[]) {
  const seen = new Set<string>();
  const output: EngagementStyleSample[] = [];
  for (const value of values) {
    const key = value.text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function quantile(values: number[], fraction: number) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
}

function emptyIntentBuckets(): Record<EngagementCommentIntent, number> {
  return {
    reaction: 0,
    question: 0,
    price: 0,
    comparison: 0,
    skeptical: 0,
    experience: 0,
    follow: 0,
    chatter: 0
  };
}

function presetIntentBuckets(channel: EngagementStyleChannel): Record<EngagementCommentIntent, number> {
  if (channel === "douyin_comment") {
    return { reaction: 34, question: 14, price: 5, comparison: 5, skeptical: 10, experience: 16, follow: 7, chatter: 9 };
  }
  if (channel === "bilibili_comment") {
    return { reaction: 27, question: 17, price: 4, comparison: 8, skeptical: 12, experience: 12, follow: 4, chatter: 16 };
  }
  return { reaction: 48, question: 9, price: 0, comparison: 2, skeptical: 5, experience: 4, follow: 2, chatter: 30 };
}

function presetLengthBuckets(channel: EngagementStyleChannel) {
  if (channel === "bilibili_danmaku") return { short: 58, medium: 38, long: 4 };
  if (channel === "douyin_comment") return { short: 30, medium: 50, long: 20 };
  return { short: 26, medium: 52, long: 22 };
}

function channelStyleNotes(channel: EngagementStyleChannel) {
  if (channel === "douyin_comment") {
    return "抖音评论允许直接情绪、回复感和平台方括号表情；表情是少数评论的语气组成，不要每条都塞。";
  }
  if (channel === "bilibili_comment") {
    return "B站评论允许梗、考据、补充、课代表和圈内接话，但不要机械堆梗或把每条都写成长评。";
  }
  return "B站弹幕跟随画面/台词即时反应，允许短梗、接话和少量复读感，不写完整测评句。";
}

function clampRate(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
