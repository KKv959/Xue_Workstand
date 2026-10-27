import { chatComplete } from "./ai";
import { DOUYIN_RELATED_VIDEO_EXTRACT_JS } from "./opencli-douyin-scripts";
import {
  asArray,
  buildOpenCliBrowserArgs,
  parseJsonish,
  runOpenCli,
  runPersistentOpenCliBrowserAdapter,
  stringField,
  withSharedOpenCliBrowserSession
} from "./opencli-runtime";
import { isRelatedVideoRelevant, uniqueStrings } from "./opencli-normalizers";
import { extractBvid } from "./platform-links";
import type {
  PublishCopyCandidate,
  PublishCopyFramework,
  PublishCopyInput,
  PublishCopyReference,
  PublishCopyResult,
  PublishCopyTargetPlatform
} from "./publish-copy-types";
import type { Platform } from "./types";
import { clampText, nowIso, shortHash, toNumber } from "./utils";

const MAX_QUERY_COUNT = 4;
const SEARCH_LIMIT_PER_QUERY = 8;
const MAX_REFERENCE_COUNT = 14;
const DEFAULT_CANDIDATE_COUNT = 6;
const MAX_CANDIDATE_COUNT = 10;

type QueryPlan = PublishCopyResult["queryPlan"];

type SearchResult = {
  references: PublishCopyReference[];
  failedQueries: string[];
};

export async function generatePublishCopy(input: PublishCopyInput, options: { signal?: AbortSignal } = {}): Promise<PublishCopyResult> {
  const normalized = normalizePublishCopyInput(input);
  throwIfAborted(options.signal);

  const queryPlan = await buildQueryPlan(normalized, options);
  throwIfAborted(options.signal);

  const research = await collectPublishingReferences(normalized.platform, queryPlan.queries, options);
  const references = rankReferences(research.references).slice(0, MAX_REFERENCE_COUNT);
  if (!references.length) {
    const failedHint = research.failedQueries.length ? `失败查询：${research.failedQueries.join("、")}` : "搜索没有返回可用视频。";
    throw new Error(`没有抓到可用的同类选题，无法提取标题和发布文案框架。${failedHint}`);
  }

  const missingReferencePlatforms = normalized.platform === "both"
    ? (["bilibili", "douyin"] as const).filter((platform) => !references.some((reference) => reference.platform === platform))
    : [];
  const coverageWarnings = missingReferencePlatforms.map((platform) => `${formatPlatformName(platform)}：没有返回可用参考`);
  const failedQueries = uniqueStrings([...research.failedQueries, ...coverageWarnings]);

  const generated = await buildFrameworksAndCandidates({
    input: normalized,
    queryPlan,
    references,
    signal: options.signal
  });

  return {
    generatedAt: nowIso(),
    platform: normalized.platform,
    sourceSummary: summarizeSourceText(normalized.sourceText, normalized.topicHint),
    queryPlan,
    research: {
      usedQueries: queryPlan.queries,
      failedQueries,
      referenceCount: references.length,
      references
    },
    frameworks: generated.frameworks,
    candidates: generated.candidates,
    usedModel: generated.usedModel,
    fallback: generated.fallback || queryPlan.querySource === "local" || missingReferencePlatforms.length > 0,
    fallbackReason: [
      queryPlan.fallbackReason,
      generated.fallbackReason,
      coverageWarnings.length ? `参考覆盖不完整：${coverageWarnings.join("、")}` : ""
    ].filter(Boolean).join("；") || undefined
  };
}

function normalizePublishCopyInput(input: PublishCopyInput): Required<PublishCopyInput> {
  const sourceText = input.sourceText.replace(/\r/g, "").trim();
  if (!sourceText) {
    throw new Error("请先粘贴原文案。");
  }

  const candidateCount = Math.max(1, Math.min(input.candidateCount || DEFAULT_CANDIDATE_COUNT, MAX_CANDIDATE_COUNT));
  return {
    platform: input.platform || "both",
    sourceText,
    topicHint: input.topicHint?.trim() || "",
    candidateCount
  };
}

async function buildQueryPlan(input: Required<PublishCopyInput>, options: { signal?: AbortSignal }): Promise<QueryPlan> {
  const localQueries = buildLocalSearchQueries(input.sourceText, input.topicHint);
  const result = await chatComplete(
    [
      {
        role: "system",
        content: "你是短视频选题检索词规划员。只输出 JSON，不要解释。"
      },
      {
        role: "user",
        content: `请根据用户原文案提取适合去 B站 / 抖音搜索同类选题的检索词。

要求：
1. 检索词要短，优先使用具体对象、场景、痛点、品类或反差结论。
2. 不要使用“文案、生成、爆款、标题、发布”这类泛词。
3. 输出 JSON：{"topic":"一句话概括选题","queries":["检索词1","检索词2","检索词3","检索词4"]}。

用户补充关键词：${input.topicHint || "无"}
原文案：
${input.sourceText}`
      }
    ],
    "medium",
    { policy: "publish_plan", signal: options.signal }
  );
  throwIfAborted(options.signal);

  if (!result.text.trim()) {
    return {
      topic: localQueries[0],
      queries: localQueries,
      querySource: "local",
      fallbackReason: result.fallbackReason || result.userMessage || "模型没有返回检索词，已使用本地关键词提取。"
    };
  }

  const parsed = parseJsonObject(result.text);
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const modelQueries = normalizeStringList(object.queries, MAX_QUERY_COUNT);
  const queries = uniqueStrings([...modelQueries, ...localQueries])
    .map(cleanSearchQuery)
    .filter(Boolean)
    .slice(0, MAX_QUERY_COUNT);

  if (!queries.length) {
    return {
      topic: localQueries[0],
      queries: localQueries,
      querySource: "local",
      fallbackReason: "模型返回的检索词不可用，已使用本地关键词提取。"
    };
  }

  return {
    topic: cleanInlineText(stringField(object.topic)) || queries[0],
    queries,
    querySource: result.ok ? "model" : "local",
    fallbackReason: result.fallback ? result.fallbackReason || "模型检索词规划不可用，已合并本地关键词。" : undefined
  };
}

async function collectPublishingReferences(
  platform: PublishCopyTargetPlatform,
  queries: string[],
  options: { signal?: AbortSignal }
): Promise<SearchResult> {
  const platforms = platform === "both" ? ["bilibili", "douyin"] as const : [platform];
  const references: PublishCopyReference[] = [];
  const failedQueries: string[] = [];

  for (const query of queries) {
    throwIfAborted(options.signal);
    for (const targetPlatform of platforms) {
      try {
        references.push(...(await searchPlatformReferences(targetPlatform, query, options)));
      } catch (error) {
        if (isAbortError(error)) throw error;
        failedQueries.push(`${formatPlatformName(targetPlatform)}：${query}`);
      }
    }
  }

  return {
    references: dedupeReferences(references),
    failedQueries: uniqueStrings(failedQueries)
  };
}

function searchPlatformReferences(platform: Platform, query: string, options: { signal?: AbortSignal }) {
  return platform === "bilibili"
    ? searchBilibiliReferences(query, options)
    : searchDouyinReferences(query, options);
}

async function searchBilibiliReferences(query: string, options: { signal?: AbortSignal }): Promise<PublishCopyReference[]> {
  const stdout = await runPersistentOpenCliBrowserAdapter([
    "bilibili",
    "search",
    query,
    "--type",
    "video",
    "--limit",
    String(SEARCH_LIMIT_PER_QUERY),
    "-f",
    "json"
  ], { timeout: 35_000, signal: options.signal });

  const rows = asArray(parseJsonish(stdout));
  return normalizeSearchRows(rows, "bilibili", query);
}

async function searchDouyinReferences(query: string, options: { signal?: AbortSignal }): Promise<PublishCopyReference[]> {
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(query)}?type=general`;

  return withSharedOpenCliBrowserSession(async (workspace) => {
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "open", [searchUrl], { window: "background" }), {
      timeout: 30_000,
      signal: options.signal
    });
    await runOpenCli(buildOpenCliBrowserArgs(workspace, "wait", ["time", "5"]), {
      timeout: 12_000,
      signal: options.signal
    }).catch(() => undefined);
    const rows = asArray(parseJsonish(await runOpenCli(
      buildOpenCliBrowserArgs(workspace, "eval", [DOUYIN_RELATED_VIDEO_EXTRACT_JS]),
      { timeout: 24_000, signal: options.signal }
    )));
    return normalizeSearchRows(rows, "douyin", query);
  }, { signal: options.signal });
}

function normalizeSearchRows(rows: unknown[], platform: Platform, query: string) {
  const normalized = rows
    .map((row) => normalizeReferenceRow(row, platform, query))
    .filter((reference): reference is PublishCopyReference => Boolean(reference?.title));
  const relevant = normalized.filter((reference) => isRelatedVideoRelevant(reference.title, query));
  return (relevant.length ? relevant : normalized).slice(0, SEARCH_LIMIT_PER_QUERY);
}

function normalizeReferenceRow(row: unknown, platform: Platform, query: string): PublishCopyReference | null {
  const object = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const rawUrl = stringField(object.url) || stringField(object.link) || stringField(object.href);
  const id = platform === "bilibili"
    ? extractBvid(rawUrl || stringField(object.id) || stringField(object.bvid) || stringField(object.aid)) || shortHash(JSON.stringify(object))
    : stringField(object.id) || stringField(object.aweme_id) || shortHash(JSON.stringify(object));
  const title = stripMarkup(stringField(object.title) || stringField(object.name) || stringField(object.desc));
  if (!title) return null;

  const caption = stripMarkup(
    stringField(object.description) ||
    stringField(object.desc) ||
    stringField(object.content) ||
    stringField(object.summary) ||
    stringField(object.dynamic) ||
    title
  );
  const url = rawUrl || (platform === "bilibili"
    ? `https://www.bilibili.com/video/${id}`
    : `https://www.douyin.com/video/${id}`);
  const stats = {
    views: firstPositiveNumber(object.views, object.view, object.play, object.plays),
    likes: firstPositiveNumber(object.likes, object.like, object.digg_count),
    comments: firstPositiveNumber(object.comments, object.comment, object.reply),
    favorites: firstPositiveNumber(object.favorites, object.favorite, object.collect),
    shares: firstPositiveNumber(object.shares, object.share)
  };
  const score = (stats.views || 0) + (stats.likes || toNumber(object.likes)) * 8 + (stats.comments || 0) * 20 + (stats.favorites || 0) * 6;

  return {
    id: `${platform}:${id}`,
    platform,
    query,
    title,
    caption,
    author: stringField(object.author) || stringField(object.owner) || stringField(object.uname) || stringField(object.nickname),
    url,
    stats,
    score
  };
}

async function buildFrameworksAndCandidates(input: {
  input: Required<PublishCopyInput>;
  queryPlan: QueryPlan;
  references: PublishCopyReference[];
  signal?: AbortSignal;
}): Promise<Pick<PublishCopyResult, "frameworks" | "candidates" | "usedModel" | "fallback" | "fallbackReason">> {
  const local = buildLocalFrameworkResult(input.input, input.references);
  const result = await chatComplete(
    [
      {
        role: "system",
        content:
          "你是中文短视频发布策略编辑。你必须先从平台参考样本抽象标题和发布文案框架，再基于用户原文生成新标题和发布文案。只输出 JSON。"
      },
      {
        role: "user",
        content: `用户原文案：
${clampText(input.input.sourceText, 2600)}

选题概括：${input.queryPlan.topic}
目标平台：${formatTargetPlatform(input.input.platform)}

平台参考样本：
${formatReferenceSamples(input.references)}

请输出 JSON：
{
  "frameworks": [
    {
      "name": "框架名，短中文",
      "titlePattern": "标题公式，不要照抄样本",
      "captionPattern": "发布文案公式",
      "openingMove": "开头动作",
      "structure": "正文结构，写成一句",
      "reusableSlots": ["可替换槽位，3-6 个"],
      "fitReason": "为什么适合用户原文"
    }
  ],
  "candidates": [
    {
      "title": "新标题",
      "caption": "新发布文案，适合平台发布，不要写口播正文全文",
      "platform": "both 或 bilibili 或 douyin",
      "angle": "切入角度",
      "frameworkName": "使用的框架名"
    }
  ]
}

硬性要求：
1. 标题和发布文案都必须是新写的，不照抄参考样本。
2. 只能使用用户原文里的事实、对象、场景和平台参考里抽象出的表达框架，不新增无法确认的数据。
3. 候选数量 ${input.input.candidateCount} 条。
4. 发布文案要像真实发布说明或短视频 caption，短、具体、有评论区引导。`
      }
    ],
    "medium",
    { policy: "publish_generate", signal: input.signal }
  );
  throwIfAborted(input.signal);

  if (!result.text.trim()) {
    return {
      ...local,
      usedModel: result.model,
      fallback: true,
      fallbackReason: result.fallbackReason || result.userMessage || "模型没有返回可用生成结果，已使用本地框架草稿。"
    };
  }

  const parsed = parseJsonObject(result.text);
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const frameworks = normalizeFrameworks(object.frameworks);
  const candidates = normalizeCandidates(object.candidates, input.input.platform, input.input.candidateCount);

  if (!frameworks.length || !candidates.length) {
    return {
      ...local,
      usedModel: result.model,
      fallback: true,
      fallbackReason: "模型返回内容不是可用 JSON，已使用本地框架草稿。"
    };
  }

  return {
    frameworks,
    candidates,
    usedModel: result.model,
    fallback: result.fallback,
    fallbackReason: result.fallbackReason
  };
}

function buildLocalFrameworkResult(
  input: Required<PublishCopyInput>,
  references: PublishCopyReference[]
): Pick<PublishCopyResult, "frameworks" | "candidates"> {
  const sourceSummary = summarizeSourceText(input.sourceText, input.topicHint);
  const topTitles = references.slice(0, 5).map((reference) => reference.title);
  const object = input.topicHint || sourceSummary;
  const frameworks: PublishCopyFramework[] = [
    {
      name: "反差判断",
      titlePattern: "对象 + 反常识判断 + 结果悬念",
      captionPattern: "先抛判断，再给一个具体场景，最后留评论区问题。",
      openingMove: "一句话把原文里的冲突说透。",
      structure: "判断，场景，理由，互动。",
      reusableSlots: ["对象", "反差点", "使用场景", "观众顾虑"],
      fitReason: topTitles.length ? `参考标题多用强判断或悬念：${topTitles.slice(0, 2).join(" / ")}` : "适合把原文提炼成更明确的点击理由。"
    },
    {
      name: "场景痛点",
      titlePattern: "人群 / 场景 + 痛点 + 新发现",
      captionPattern: "先点名适用人群，再给一个痛点和一个可讨论的问题。",
      openingMove: "把原文里的具体场景前置。",
      structure: "人群，痛点，解决角度，评论区追问。",
      reusableSlots: ["人群", "场景", "痛点", "意外发现"],
      fitReason: "适合从原文中提取可被搜索和推荐识别的场景词。"
    }
  ];

  const baseCandidates: PublishCopyCandidate[] = [
    {
      title: clampTitle(`${object}，别只看表面`),
      caption: buildLocalCaption(sourceSummary, "你更在意结果，还是过程里的这个细节？"),
      platform: input.platform,
      angle: "反差判断",
      frameworkName: frameworks[0].name
    },
    {
      title: clampTitle(`这类${object}，真正影响体验的是这里`),
      caption: buildLocalCaption(sourceSummary, "同类选题你还想看哪一类对比？"),
      platform: input.platform,
      angle: "场景痛点",
      frameworkName: frameworks[1].name
    }
  ];

  return {
    frameworks,
    candidates: fillCandidates(baseCandidates, input.candidateCount, sourceSummary, input.platform)
  };
}

function fillCandidates(
  candidates: PublishCopyCandidate[],
  count: number,
  sourceSummary: string,
  platform: PublishCopyTargetPlatform
) {
  const next = [...candidates];
  const templates = [
    ["先别急着下结论，核心差别在这一步", "反差补充"],
    ["如果你也遇到这个场景，可以先看这个点", "场景补充"],
    ["同样的选题，换个角度看会更清楚", "角度补充"],
    ["这件事最容易被忽略的，其实不是表面原因", "问题补充"]
  ] as const;
  let index = 0;
  while (next.length < count) {
    const template = templates[index % templates.length];
    next.push({
      title: clampTitle(`${sourceSummary}：${template[0]}`),
      caption: buildLocalCaption(sourceSummary, "你会怎么选？评论区聊。"),
      platform,
      angle: template[1],
      frameworkName: next[index % Math.max(next.length, 1)]?.frameworkName || "反差判断"
    });
    index += 1;
  }
  return next.slice(0, count);
}

function normalizeFrameworks(value: unknown): PublishCopyFramework[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const object = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const name = cleanInlineText(stringField(object.name));
      const titlePattern = cleanInlineText(stringField(object.titlePattern));
      const captionPattern = cleanInlineText(stringField(object.captionPattern));
      if (!name || !titlePattern || !captionPattern) return null;
      return {
        name,
        titlePattern,
        captionPattern,
        openingMove: cleanInlineText(stringField(object.openingMove)),
        structure: cleanInlineText(stringField(object.structure)),
        reusableSlots: normalizeStringList(object.reusableSlots, 8),
        fitReason: cleanInlineText(stringField(object.fitReason))
      };
    })
    .filter((item): item is PublishCopyFramework => Boolean(item))
    .slice(0, 6);
}

function normalizeCandidates(
  value: unknown,
  fallbackPlatform: PublishCopyTargetPlatform,
  limit: number
): PublishCopyCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const object = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const title = cleanInlineText(stringField(object.title));
      const caption = cleanMultilineText(stringField(object.caption));
      if (!title || !caption) return null;
      return {
        title: clampTitle(title),
        caption,
        platform: normalizeTargetPlatform(stringField(object.platform)) || fallbackPlatform,
        angle: cleanInlineText(stringField(object.angle)),
        frameworkName: cleanInlineText(stringField(object.frameworkName))
      };
    })
    .filter((item): item is PublishCopyCandidate => Boolean(item))
    .slice(0, limit);
}

function buildLocalSearchQueries(sourceText: string, topicHint: string) {
  const cleaned = cleanSearchQuery(topicHint) || cleanSearchQuery(firstMeaningfulSentence(sourceText));
  const tokens = extractSearchTokens(sourceText);
  const queries = uniqueStrings([
    cleaned,
    tokens.slice(0, 2).join(" "),
    tokens.slice(0, 3).join(" "),
    ...tokens
  ])
    .map(cleanSearchQuery)
    .filter((query) => query.length >= 2)
    .slice(0, MAX_QUERY_COUNT);
  return queries.length ? queries : [clampText(cleanSearchQuery(sourceText), 24)];
}

function extractSearchTokens(text: string) {
  const compact = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9.+#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const modelTerms = Array.from(compact.matchAll(/[A-Za-z]{2,}[-+]?\d{0,4}|[A-Za-z0-9]+(?:[.+#-][A-Za-z0-9]+)+/g))
    .map((match) => match[0]);
  const chineseTerms = Array.from(compact.matchAll(/[\u4e00-\u9fa5]{2,8}/g))
    .map((match) => match[0])
    .filter((term) => !PUBLISH_QUERY_STOP_WORDS.has(term));
  return uniqueStrings([...modelTerms, ...chineseTerms]).slice(0, 8);
}

function firstMeaningfulSentence(text: string) {
  return text
    .split(/[\n。！？!?；;]/)
    .map((line) => line.trim())
    .find((line) => line && !/^https?:\/\//i.test(line)) || text;
}

function summarizeSourceText(sourceText: string, topicHint: string) {
  return clampTitle(topicHint || firstMeaningfulSentence(sourceText));
}

function formatReferenceSamples(references: PublishCopyReference[]) {
  return references
    .slice(0, MAX_REFERENCE_COUNT)
    .map((reference, index) => [
      `${index + 1}. ${formatPlatformName(reference.platform)}｜${reference.title}`,
      reference.caption && reference.caption !== reference.title ? `发布文案：${reference.caption}` : "",
      reference.author ? `作者：${reference.author}` : "",
      `数据：${formatStats(reference)}`,
      `链接：${reference.url}`
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatStats(reference: PublishCopyReference) {
  const stats = reference.stats || {};
  return [
    stats.views ? `播放 ${stats.views}` : "",
    stats.likes ? `点赞 ${stats.likes}` : "",
    stats.comments ? `评论 ${stats.comments}` : "",
    stats.favorites ? `收藏 ${stats.favorites}` : "",
    stats.shares ? `分享 ${stats.shares}` : ""
  ].filter(Boolean).join(" / ") || `热度 ${reference.score}`;
}

function dedupeReferences(references: PublishCopyReference[]) {
  const byKey = new Map<string, PublishCopyReference>();
  for (const reference of references) {
    const key = reference.url || `${reference.platform}:${reference.title}`;
    const existing = byKey.get(key);
    if (!existing || reference.score > existing.score) byKey.set(key, reference);
  }
  return [...byKey.values()];
}

function rankReferences(references: PublishCopyReference[]) {
  return [...references].sort((left, right) => right.score - left.score || left.title.length - right.title.length);
}

function normalizeStringList(value: unknown, limit: number) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n，、]/) : [];
  return uniqueStrings(values.map((item) => cleanInlineText(String(item || "")))).slice(0, limit);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const jsonText = trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1] || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function stripMarkup(value: string) {
  return cleanMultilineText(value.replace(/<[^>]*>/g, " "));
}

function cleanSearchQuery(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#【】"'“”‘’《》<>()[\]{}]/g, " ")
    .replace(/\b(?:bilibili|douyin|抖音|B站|小红书)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

function cleanInlineText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanMultilineText(value: string) {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstPositiveNumber(...values: unknown[]) {
  for (const value of values) {
    const number = toNumber(value);
    if (number > 0) return number;
  }
  return undefined;
}

function clampTitle(value: string) {
  const clean = cleanInlineText(value);
  return Array.from(clean).slice(0, 42).join("");
}

function buildLocalCaption(summary: string, question: string) {
  return [summary, "先把同类选题里的标题结构拆出来，再换成这条内容自己的钩子。", question].join("\n");
}

function normalizeTargetPlatform(value: string): PublishCopyTargetPlatform | "" {
  if (value === "bilibili" || value === "douyin" || value === "both") return value;
  if (/B站|b站/i.test(value)) return "bilibili";
  if (/抖音|douyin/i.test(value)) return "douyin";
  return "";
}

function formatTargetPlatform(platform: PublishCopyTargetPlatform) {
  if (platform === "both") return "B站和抖音";
  return formatPlatformName(platform);
}

function formatPlatformName(platform: Platform) {
  return platform === "bilibili" ? "B站" : "抖音";
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("任务已停止");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

const PUBLISH_QUERY_STOP_WORDS = new Set([
  "这个",
  "那个",
  "今天",
  "视频",
  "文案",
  "标题",
  "发布",
  "生成",
  "爆款",
  "然后",
  "因为",
  "所以",
  "但是",
  "如果",
  "可以",
  "我们",
  "你们",
  "大家"
]);
