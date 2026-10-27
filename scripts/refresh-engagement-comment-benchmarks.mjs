import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_VERSION = 2;
const LOCAL_ONLY = process.argv.includes("--local-only");
const BILIBILI_HOT_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_HOT_LIMIT, 0, 20, 6);
const BILIBILI_VIDEOS_PER_QUERY = clampInteger(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_VIDEOS_PER_QUERY, 1, 5, 3);
const BILIBILI_VIDEO_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_VIDEO_LIMIT, 4, 60, 36);
const BILIBILI_COMMENT_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_COMMENT_LIMIT, 5, 50, 30);
const BILIBILI_DANMAKU_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_DANMAKU_LIMIT, 20, 500, 180);
const BILIBILI_DIGITAL_VIDEO_SHARE = clampRate(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_DIGITAL_VIDEO_SHARE, 0.3, 0.9, 0.67);
const BILIBILI_ACCOUNT_VIDEO_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_ACCOUNT_VIDEO_LIMIT, 1, 8, 2);
const BILIBILI_REQUEST_INTERVAL_MS = clampInteger(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_REQUEST_INTERVAL_MS, 0, 5_000, 750);
const DOUYIN_VIDEO_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_DOUYIN_VIDEO_LIMIT, 1, 20, 12);
const DOUYIN_COMMENT_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_DOUYIN_COMMENT_LIMIT, 1, 10, 10);
const DOUYIN_SEARCH_VIDEOS_PER_QUERY = clampInteger(process.env.ENGAGEMENT_BENCHMARK_DOUYIN_SEARCH_VIDEOS_PER_QUERY, 0, 3, 1);
const DOUYIN_SEARCH_COMMENT_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_DOUYIN_SEARCH_COMMENT_LIMIT, 5, 30, 20);
const LOCAL_VIDEOS_PER_ACCOUNT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_LOCAL_VIDEOS_PER_ACCOUNT, 5, 80, 24);
const CHANNEL_SAMPLE_LIMIT = clampInteger(process.env.ENGAGEMENT_BENCHMARK_CHANNEL_SAMPLE_LIMIT, 500, 20_000, 8_000);
const BILIBILI_QUERIES = parseBilibiliQueries(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_QUERIES);
const BILIBILI_PREFERRED_ACCOUNTS = parseBilibiliPreferredAccounts(process.env.ENGAGEMENT_BENCHMARK_BILIBILI_PREFERRED_ACCOUNTS);
const DOUYIN_ACCOUNTS = parseDouyinAccounts(process.env.ENGAGEMENT_BENCHMARK_DOUYIN_ACCOUNTS);
const DOUYIN_QUERIES = parseDouyinQueries(process.env.ENGAGEMENT_BENCHMARK_DOUYIN_QUERIES);
const OPENCLI_BROWSER_SESSION = process.env.OPENCLI_BROWSER_SESSION?.trim() || "content-workbench-browser";

const libraryRoot = path.resolve(process.env.STYLE_LIBRARY_DIR || "./style-library");
const cacheDirectory = path.join(libraryRoot, "engagement", ".cache", "style");
const cachePath = path.join(cacheDirectory, "benchmark-comments.json");

const local = await collectLocalCorpus(libraryRoot);
const remote = LOCAL_ONLY
  ? { videos: [], samples: [], sources: [], failures: [] }
  : await collectRemoteBenchmarks();
const videos = uniqueBy([...local.videos, ...remote.videos], (video) => `${video.platform}:${video.videoId}`);
const samples = capSamplesByChannel(
  uniqueBy([...local.samples, ...remote.samples], (sample) =>
    `${sample.channel}\u0000${sample.videoId}\u0000${commentFingerprint(sample.text)}`
  ),
  CHANNEL_SAMPLE_LIMIT
);
const quality = buildBenchmarkQuality(videos, samples);
const payload = {
  version: CACHE_VERSION,
  generatedAt: new Date().toISOString(),
  policy: {
    mode: LOCAL_ONLY ? "local-only" : "bounded-refresh",
    bilibiliHotLimit: BILIBILI_HOT_LIMIT,
    bilibiliVideosPerQuery: BILIBILI_VIDEOS_PER_QUERY,
    bilibiliVideoLimit: BILIBILI_VIDEO_LIMIT,
    bilibiliCommentLimit: BILIBILI_COMMENT_LIMIT,
    bilibiliDanmakuLimit: BILIBILI_DANMAKU_LIMIT,
    bilibiliDigitalVideoShare: BILIBILI_DIGITAL_VIDEO_SHARE,
    bilibiliAccountVideoLimit: BILIBILI_ACCOUNT_VIDEO_LIMIT,
    bilibiliRequestIntervalMs: BILIBILI_REQUEST_INTERVAL_MS,
    bilibiliPreferredAccounts: BILIBILI_PREFERRED_ACCOUNTS,
    douyinVideoLimit: DOUYIN_VIDEO_LIMIT,
    douyinCommentLimit: DOUYIN_COMMENT_LIMIT,
    douyinSearchVideosPerQuery: DOUYIN_SEARCH_VIDEOS_PER_QUERY,
    douyinSearchCommentLimit: DOUYIN_SEARCH_COMMENT_LIMIT,
    localVideosPerAccount: LOCAL_VIDEOS_PER_ACCOUNT,
    channelSampleLimit: CHANNEL_SAMPLE_LIMIT,
    queries: BILIBILI_QUERIES
  },
  sources: [
    {
      kind: "local-library",
      videoCount: local.videos.length,
      sampleCount: local.samples.length
    },
    ...remote.sources
  ],
  failures: remote.failures,
  quality,
  coverage: buildCoverage(videos, samples),
  videos,
  samples
};

await fs.mkdir(cacheDirectory, { recursive: true });
const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await fs.rename(temporaryPath, cachePath);

for (const row of payload.coverage) {
  process.stdout.write(
    `${row.channel}：${row.videoCount} 个视频，${row.sampleCount} 条样本，题材 ${row.topics.slice(0, 4).map((item) => item.topic).join("/") || "general"}\n`
  );
}
process.stdout.write(
  `B站质量：${quality.bilibili.digitalVideoCount}/${quality.bilibili.videoCount} 个数码视频，`
  + `${quality.bilibili.commentSampleCount} 条评论，过滤 ${quality.bilibili.rejectedCommentCount} 条抽奖/导流噪声\n`
);
if (payload.failures.length) {
  process.stdout.write(`有 ${payload.failures.length} 个远端样本源失败，已保留其余成功结果；详情写入缓存 failures。\n`);
}
process.stdout.write(`标杆语料缓存已更新：${cachePath}\n`);

async function collectLocalCorpus(root) {
  const roots = [
    path.join(root, "douyin"),
    path.join(root, "bilibili"),
    path.join(root, "douyin-hotlist", "accounts")
  ];
  const files = [];
  for (const target of roots) {
    files.push(...await findVideoJsonFiles(target));
  }

  const rows = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") rows.push({ filePath, parsed });
    } catch (error) {
      throw new Error(`本地标杆视频 JSON 损坏：${filePath}。${formatError(error)}`);
    }
  }

  const selected = selectLocalVideos(rows);
  const videos = [];
  const samples = [];
  for (const { filePath, parsed } of selected) {
    const platform = parsed.platform === "bilibili" ? "bilibili" : parsed.platform === "douyin" ? "douyin" : "";
    if (!platform) continue;
    const videoId = String(parsed.id || path.basename(filePath, ".json")).trim();
    const videoTitle = normalizeText(parsed.title);
    const accountName = normalizeAccountName(parsed.accountName || parsed.authorName || accountNameFromVideoPath(filePath));
    const stats = normalizeStats(parsed.stats || parsed.statistics || {});
    const topics = inferTopics(videoTitle);
    const contentTypes = inferContentTypes(videoTitle);
    const comments = Array.isArray(parsed.topComments) ? parsed.topComments : [];
    const danmaku = platform === "bilibili" && Array.isArray(parsed.danmakuSamples) ? parsed.danmakuSamples : [];
    if (!comments.length && !danmaku.length) continue;

    videos.push({
      platform,
      videoId,
      videoTitle,
      accountName,
      source: "library",
      topics,
      contentTypes,
      stats,
      durationSec: parseDurationSec(parsed.duration),
      commentSampleCount: comments.length,
      danmakuSampleCount: danmaku.length
    });

    comments.slice(0, 50).forEach((comment, index) => {
      const row = normalizeComment(comment, index);
      if (!row) return;
      samples.push(makeSample({
        channel: `${platform}_comment`,
        platform,
        kind: "comment",
        videoId,
        videoTitle,
        accountName,
        topics,
        contentTypes,
        source: "library",
        ...row
      }));
    });
    danmaku.slice(0, 500).forEach((item, index) => {
      const row = normalizeDanmaku(item, index, parseDurationSec(parsed.duration));
      if (!row) return;
      samples.push(makeSample({
        channel: "bilibili_danmaku",
        platform: "bilibili",
        kind: "danmaku",
        videoId,
        videoTitle,
        accountName,
        topics,
        contentTypes,
        source: "library",
        ...row
      }));
    });
  }
  return { videos, samples };
}

async function collectRemoteBenchmarks() {
  const bilibili = await collectBilibiliBenchmarks();
  validateRemoteBenchmarkCoverage(bilibili);
  return mergeRemoteCorpus(bilibili, await collectDouyinBenchmarks());
}

function selectLocalVideos(rows) {
  const groups = new Map();
  for (const row of rows) {
    const platform = row.parsed.platform === "bilibili" ? "bilibili" : row.parsed.platform === "douyin" ? "douyin" : "";
    if (!platform) continue;
    const account = normalizeAccountName(row.parsed.accountName || row.parsed.authorName || accountNameFromVideoPath(row.filePath));
    const key = `${platform}:${account}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => group
    .sort((left, right) => videoQualityScore(right.parsed) - videoQualityScore(left.parsed))
    .slice(0, LOCAL_VIDEOS_PER_ACCOUNT));
}

async function collectBilibiliBenchmarks() {
  const failures = [];
  const candidateMap = new Map();
  const sources = [];

  if (BILIBILI_HOT_LIMIT > 0) {
    try {
      const rows = await runOpenCliJson([
        "bilibili", "hot", "--limit", String(BILIBILI_HOT_LIMIT), "--site-session", "persistent", "-f", "json",
        "--trace", "retain-on-failure"
      ], 90_000);
      for (const row of asArray(rows)) addBilibiliCandidate(candidateMap, row, ["general"], "hot");
      sources.push({ kind: "bilibili-hot", requested: BILIBILI_HOT_LIMIT, discovered: asArray(rows).length });
    } catch (error) {
      failures.push({ source: "bilibili-hot", error: formatError(error) });
    }
  }

  for (const query of BILIBILI_QUERIES) {
    try {
      const rows = await runOpenCliJson([
        "bilibili", "search", query.query, "--type", "video", "--limit",
        String(Math.max(BILIBILI_VIDEOS_PER_QUERY * 4, 12)),
        "--site-session", "persistent", "-f", "json", "--trace", "retain-on-failure"
      ], 90_000);
      const discovered = asArray(rows)
        .filter((row) => extractBvid(row?.url || row?.bvid || ""));
      const editorial = discovered.filter((row) => !isBilibiliSeoFarmTitle(row?.title));
      const discoveryPool = editorial.length >= BILIBILI_VIDEOS_PER_QUERY ? editorial : discovered;
      const topicRelevant = query.topic === "digital_ai"
        ? discoveryPool.filter((row) => isDigitalBenchmarkText(row?.title))
        : discoveryPool;
      const usable = (topicRelevant.length >= BILIBILI_VIDEOS_PER_QUERY ? topicRelevant : discoveryPool)
        .sort((left, right) => bilibiliSearchRowQualityScore(right) - bilibiliSearchRowQualityScore(left))
        .slice(0, BILIBILI_VIDEOS_PER_QUERY);
      for (const row of usable) addBilibiliCandidate(candidateMap, row, [query.topic], `search:${query.query}`);
      sources.push({
        kind: "bilibili-search",
        topic: query.topic,
        query: query.query,
        requested: BILIBILI_VIDEOS_PER_QUERY,
        discovered: usable.length
      });
    } catch (error) {
      failures.push({ source: `bilibili-search:${query.query}`, error: formatError(error) });
    }
  }

  const candidates = selectBilibiliCandidates(
    [...candidateMap.values()].sort((left, right) => bilibiliCandidateQualityScore(right) - bilibiliCandidateQualityScore(left)),
    BILIBILI_VIDEO_LIMIT
  );
  const videos = [];
  const samples = [];
  let consecutiveVideoFailures = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const bundle = await fetchBilibiliVideoBundle(candidate);
      videos.push(bundle.video);
      samples.push(...bundle.samples);
      consecutiveVideoFailures = 0;
      process.stdout.write(
        `B站标杆 ${index + 1}/${candidates.length}：${bundle.video.videoTitle}，${bundle.video.commentSampleCount} 评论，${bundle.video.danmakuSampleCount} 弹幕\n`
      );
    } catch (error) {
      const message = formatError(error);
      failures.push({ source: `bilibili-video:${candidate.videoId}`, error: message });
      consecutiveVideoFailures += 1;
      if (consecutiveVideoFailures >= 3) {
        throw new Error(`B站评论连续 ${consecutiveVideoFailures} 个视频读取失败，已中止刷新并保留上一份缓存。最近错误：${message}`);
      }
    }
    if (index + 1 < candidates.length && BILIBILI_REQUEST_INTERVAL_MS > 0) {
      await wait(BILIBILI_REQUEST_INTERVAL_MS);
    }
  }
  return { videos, samples, sources, failures };
}

async function collectDouyinBenchmarks() {
  const videos = [];
  const samples = [];
  const sources = [];
  const failures = [];
  for (const account of DOUYIN_ACCOUNTS) {
    try {
      const rows = asArray(await runOpenCliJson([
        "douyin", "user-videos", account.secUid,
        "--limit", String(DOUYIN_VIDEO_LIMIT),
        "--with_comments", "true",
        "--comment_limit", String(DOUYIN_COMMENT_LIMIT),
        "--site-session", "persistent",
        "-f", "json",
        "--trace", "retain-on-failure"
      ], 180_000));
      let commentCount = 0;
      for (const row of rows) {
        const videoId = String(row?.aweme_id || row?.id || "").trim();
        const videoTitle = normalizeText(row?.title || row?.desc);
        if (!videoId || !videoTitle) continue;
        const topics = inferTopics(videoTitle);
        const contentTypes = inferContentTypes(videoTitle);
        const comments = (Array.isArray(row?.top_comments) ? row.top_comments : [])
          .map(normalizeComment)
          .filter(Boolean);
        if (!comments.length) continue;
        const common = {
          platform: "douyin",
          videoId,
          videoTitle,
          accountName: account.name,
          topics,
          contentTypes,
          source: "benchmark"
        };
        videos.push({
          ...common,
          discoverySources: [`account:${account.name}`],
          stats: normalizeStats(row?.statistics || row?.stats || row),
          durationSec: parseDurationSec(row?.duration),
          commentSampleCount: comments.length,
          danmakuSampleCount: 0
        });
        samples.push(...comments.map((comment) => makeSample({
          channel: "douyin_comment",
          kind: "comment",
          ...common,
          ...comment
        })));
        commentCount += comments.length;
      }
      sources.push({
        kind: "douyin-account",
        accountName: account.name,
        requestedVideos: DOUYIN_VIDEO_LIMIT,
        discoveredVideos: rows.length,
        commentCount
      });
      process.stdout.write(`抖音标杆 ${account.name}：${rows.length} 个视频，${commentCount} 条评论\n`);
    } catch (error) {
      failures.push({ source: `douyin-account:${account.name}`, error: formatError(error) });
    }
  }
  if (DOUYIN_SEARCH_VIDEOS_PER_QUERY > 0) {
    const candidateMap = new Map();
    for (const query of DOUYIN_QUERIES) {
      try {
        const rows = asArray(await runOpenCliJson([
          "douyin", "search", query.query,
          "--limit", String(Math.max(DOUYIN_SEARCH_VIDEOS_PER_QUERY * 2, DOUYIN_SEARCH_VIDEOS_PER_QUERY)),
          "--site-session", "persistent",
          "-f", "json",
          "--trace", "retain-on-failure"
        ], 90_000));
        const usable = rows
          .filter((row) => extractDouyinVideoId(row?.url || row?.aweme_id || ""))
          .slice(0, DOUYIN_SEARCH_VIDEOS_PER_QUERY);
        for (const row of usable) {
          const videoId = extractDouyinVideoId(row?.url || row?.aweme_id || "");
          const videoTitle = normalizeText(row?.desc || row?.title);
          candidateMap.set(videoId, {
            videoId,
            videoTitle,
            accountName: normalizeAccountName(row?.author || "抖音标杆账号"),
            url: normalizeText(row?.url) || `https://www.douyin.com/video/${videoId}`,
            topics: uniqueText([query.topic, ...inferTopics(videoTitle)]),
            contentTypes: inferContentTypes(videoTitle),
            stats: normalizeStats(row)
          });
        }
        sources.push({
          kind: "douyin-search",
          topic: query.topic,
          query: query.query,
          requested: DOUYIN_SEARCH_VIDEOS_PER_QUERY,
          discovered: usable.length
        });
      } catch (error) {
        failures.push({ source: `douyin-search:${query.query}`, error: formatError(error) });
      }
    }
    const candidates = [...candidateMap.values()];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const comments = await fetchDouyinVideoComments(candidate);
        if (!comments.length) continue;
        const common = {
          platform: "douyin",
          videoId: candidate.videoId,
          videoTitle: candidate.videoTitle,
          accountName: candidate.accountName,
          topics: candidate.topics,
          contentTypes: candidate.contentTypes,
          source: "benchmark"
        };
        videos.push({
          ...common,
          discoverySources: [`search:${candidate.topics[0] || "general"}`],
          stats: candidate.stats,
          durationSec: 0,
          commentSampleCount: comments.length,
          danmakuSampleCount: 0
        });
        samples.push(...comments.map((comment) => makeSample({
          channel: "douyin_comment",
          kind: "comment",
          ...common,
          ...comment
        })));
        process.stdout.write(
          `抖音题材 ${index + 1}/${candidates.length}：${candidate.videoTitle}，${comments.length} 条评论\n`
        );
      } catch (error) {
        failures.push({ source: `douyin-video:${candidate.videoId}`, error: formatError(error) });
      }
    }
  }
  return { videos, samples, sources, failures };
}

async function fetchDouyinVideoComments(candidate) {
  await runOpenCli([
    "browser", "--session", OPENCLI_BROWSER_SESSION, "open", candidate.url, "--window", "background"
  ], 30_000);
  await runOpenCli(["browser", "--session", OPENCLI_BROWSER_SESSION, "wait", "time", "2"], 10_000).catch(() => undefined);
  await runOpenCli(["browser", "--session", OPENCLI_BROWSER_SESSION, "state"], 20_000);
  const result = await runOpenCliJson([
    "browser", "--session", OPENCLI_BROWSER_SESSION, "eval", buildDouyinCommentEvalJs(candidate.videoId, DOUYIN_SEARCH_COMMENT_LIMIT)
  ], 30_000);
  return asArray(result?.comments).map(normalizeComment).filter(Boolean);
}

function buildDouyinCommentEvalJs(awemeId, limit) {
  return `(async()=>{
    const url=new URL("https://www.douyin.com/aweme/v1/web/comment/list/");
    url.searchParams.set("aweme_id",${JSON.stringify(awemeId)});
    url.searchParams.set("cursor","0");
    url.searchParams.set("count",${JSON.stringify(String(limit))});
    url.searchParams.set("item_type","0");
    url.searchParams.set("device_platform","webapp");
    url.searchParams.set("aid","6383");
    const response=await fetch(url.toString(),{credentials:"include",headers:{accept:"application/json, text/plain, */*"}});
    const payload=await response.json().catch(()=>({}));
    const comments=Array.isArray(payload.comments)?payload.comments:[];
    return {status:response.status,comments:comments.map((comment,index)=>({
      rank:index+1,
      text:String(comment?.text||comment?.content||"").replace(/\\s+/g," ").trim(),
      likes:Number(comment?.digg_count||0),
      replies:Number(comment?.reply_comment_total||0)
    }))};
  })()`;
}

function mergeRemoteCorpus(...corpora) {
  return {
    videos: corpora.flatMap((corpus) => corpus.videos),
    samples: corpora.flatMap((corpus) => corpus.samples),
    sources: corpora.flatMap((corpus) => corpus.sources),
    failures: corpora.flatMap((corpus) => corpus.failures)
  };
}

function addBilibiliCandidate(target, row, seedTopics, discoverySource) {
  const videoId = extractBvid(row?.bvid || row?.url || "");
  if (!videoId) return;
  const videoTitle = normalizeText(row?.title);
  const existing = target.get(videoId);
  const topics = uniqueText([...(existing?.topics || []), ...seedTopics, ...inferTopics(videoTitle)]);
  target.set(videoId, {
    videoId,
    videoTitle: videoTitle || existing?.videoTitle || videoId,
    accountName: normalizeAccountName(row?.author || existing?.accountName || "B站标杆账号"),
    score: Math.max(toFiniteNumber(row?.score), toFiniteNumber(row?.play), existing?.score || 0),
    topics,
    contentTypes: uniqueText([...(existing?.contentTypes || []), ...inferContentTypes(videoTitle)]),
    discoverySources: uniqueText([...(existing?.discoverySources || []), discoverySource])
  });
}

async function fetchBilibiliVideoBundle(candidate) {
  const [commentsResult, viewResult] = await Promise.allSettled([
    runOpenCliJson([
      "bilibili", "comments", candidate.videoId, "--limit", String(BILIBILI_COMMENT_LIMIT),
      "--site-session", "persistent", "-f", "json", "--trace", "retain-on-failure"
    ], 90_000),
    fetchBilibiliView(candidate.videoId)
  ]);
  if (commentsResult.status === "rejected") {
    throw new Error(`评论读取失败：${formatError(commentsResult.reason)}`);
  }
  const view = viewResult.status === "fulfilled" ? viewResult.value : null;
  const videoTitle = normalizeText(view?.title || candidate.videoTitle);
  const accountName = normalizeAccountName(view?.owner?.name || candidate.accountName);
  const durationSec = toFiniteNumber(view?.duration);
  const topics = uniqueText([...candidate.topics, ...inferTopics(`${videoTitle}\n${normalizeText(view?.desc)}`)]);
  const contentTypes = uniqueText([...candidate.contentTypes, ...inferContentTypes(`${videoTitle}\n${normalizeText(view?.desc)}`)]);
  const commentRows = asArray(commentsResult.value);
  if (!commentRows.length) throw new Error("评论接口返回空结果，可能触发了临时限流");
  const danmakuRows = view?.cid
    ? await fetchBilibiliDanmaku(view.cid, durationSec).catch(() => [])
    : [];
  const normalizedComments = commentRows.map(normalizeComment).filter(Boolean);
  const comments = normalizedComments.filter((row) => !isBilibiliBenchmarkCommentNoise(row.text));
  const danmaku = deterministicSample(
    danmakuRows.map((row, index) => normalizeDanmaku(row, index, durationSec)).filter(Boolean),
    BILIBILI_DANMAKU_LIMIT,
    (row) => `${candidate.videoId}:${row.timeSec}:${row.text}`
  ).sort((left, right) => left.timeSec - right.timeSec);
  const common = {
    platform: "bilibili",
    videoId: candidate.videoId,
    videoTitle,
    accountName,
    topics,
    contentTypes,
    source: "benchmark"
  };
  return {
    video: {
      ...common,
      discoverySources: candidate.discoverySources,
      stats: normalizeStats(view?.stat || { views: candidate.score }),
      durationSec,
      commentSampleCount: comments.length,
      commentRejectedCount: normalizedComments.length - comments.length,
      danmakuSampleCount: danmaku.length
    },
    samples: [
      ...comments.map((row) => makeSample({ channel: "bilibili_comment", kind: "comment", ...common, ...row })),
      ...danmaku.map((row) => makeSample({ channel: "bilibili_danmaku", kind: "danmaku", ...common, ...row }))
    ]
  };
}

async function fetchBilibiliView(bvid) {
  const url = new URL("https://api.bilibili.com/x/web-interface/view");
  url.searchParams.set("bvid", bvid);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`B站视频元数据请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.code !== 0 || !payload?.data) throw new Error(payload?.message || "B站视频元数据为空");
  const firstPage = Array.isArray(payload.data.pages) ? payload.data.pages[0] : null;
  return {
    ...payload.data,
    cid: firstPage?.cid || payload.data.cid,
    duration: firstPage?.duration || payload.data.duration
  };
}

async function fetchBilibiliDanmaku(cid, durationSec) {
  const response = await fetch(`https://comment.bilibili.com/${encodeURIComponent(String(cid))}.xml`, {
    headers: { accept: "application/xml,text/xml,*/*", "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`B站弹幕请求失败：HTTP ${response.status}`);
  const xml = await response.text();
  const rows = [];
  const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const values = match[1].split(",");
    const text = decodeXmlText(match[2]);
    const timeSec = toFiniteNumber(values[0]);
    if (!text || timeSec < 0 || (durationSec > 0 && timeSec > durationSec + 5)) continue;
    rows.push({ text, timeSec, durationSec });
  }
  return rows;
}

async function runOpenCliJson(args, timeout) {
  const stdout = await runOpenCli(args, timeout);
  const payload = JSON.parse(stdout.trim());
  if (payload?.ok === false) throw new Error(`OpenCLI 执行失败：${JSON.stringify(payload.error)}`);
  return payload?.ok === true && "data" in payload ? payload.data : payload;
}

async function runOpenCli(args, timeout) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { command, commandArgs } = resolveOpenCliCommand(args);
      const result = await execFileAsync(command, commandArgs, {
        cwd: process.cwd(),
        env: process.env.OPENCLI_WINDOW?.trim()
          ? process.env
          : { ...process.env, OPENCLI_WINDOW: "background" },
        encoding: "utf8",
        maxBuffer: 30 * 1024 * 1024,
        timeout
      });
      return result.stdout;
    } catch (error) {
      lastError = error;
      if (isOpenCliJavaScriptDialogError(error) && args[0] === "browser" && args[1]) {
        await dismissOpenCliDialog(args[args.indexOf("--session") + 1]).catch(() => undefined);
      }
      if (attempt < 3) await wait(attempt * 750);
    }
  }
  throw new Error(formatError(lastError));
}

async function dismissOpenCliDialog(session) {
  const { command, commandArgs } = resolveOpenCliCommand(["browser", "--session", session, "dialog", "dismiss"]);
  await execFileAsync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env.OPENCLI_WINDOW?.trim()
      ? process.env
      : { ...process.env, OPENCLI_WINDOW: "background" },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000
  });
}

function isOpenCliJavaScriptDialogError(error) {
  return /javascript_dialog_open|javascript dialog|dialog is open|modal.*open/i.test(
    `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`
  );
}

function resolveOpenCliCommand(args) {
  if (process.env.OPENCLI_SCRIPT) {
    return {
      command: process.env.OPENCLI_NODE_BIN || process.execPath,
      commandArgs: [process.env.OPENCLI_SCRIPT, ...args]
    };
  }
  return { command: process.env.OPENCLI_BIN || "opencli", commandArgs: args };
}

async function findVideoJsonFiles(target) {
  const output = [];
  const entries = await fs.readdir(target, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      output.push(...await findVideoJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json") && entryPath.includes(`${path.sep}videos${path.sep}`)) {
      output.push(entryPath);
    }
  }
  return output;
}

function normalizeComment(value, index = 0) {
  const row = value && typeof value === "object" ? value : {};
  const text = normalizeSampleText(typeof value === "string" ? value : row.text || row.content || row.comment);
  if (!text) return null;
  return {
    text,
    rank: Math.max(1, Math.round(toFiniteNumber(row.rank) || index + 1)),
    likes: Math.max(0, toFiniteNumber(row.likes ?? row.digg_count)),
    replies: Math.max(0, toFiniteNumber(row.replies ?? row.reply_count))
  };
}

function normalizeDanmaku(value, index = 0, fallbackDurationSec = 0) {
  const row = value && typeof value === "object" ? value : {};
  const text = normalizeSampleText(typeof value === "string" ? value : row.text || row.content);
  if (!text || Array.from(text).length > 60) return null;
  const timeSec = Math.max(0, toFiniteNumber(row.timeSec ?? row.time ?? row.progress));
  const durationSec = Math.max(0, toFiniteNumber(row.durationSec) || fallbackDurationSec);
  return { text, rank: index + 1, likes: 0, replies: 0, timeSec, durationSec };
}

function makeSample(input) {
  return {
    channel: input.channel,
    platform: input.platform,
    kind: input.kind,
    source: input.source,
    accountName: input.accountName,
    videoId: input.videoId,
    videoTitle: input.videoTitle,
    topics: input.topics,
    contentTypes: input.contentTypes,
    text: input.text,
    rank: input.rank || 0,
    likes: input.likes || 0,
    replies: input.replies || 0,
    ...(input.kind === "danmaku"
      ? { timeSec: input.timeSec || 0, durationSec: input.durationSec || 0 }
      : {})
  };
}

function capSamplesByChannel(samples, limit) {
  const channels = new Map();
  for (const sample of samples) {
    const rows = channels.get(sample.channel) || [];
    rows.push(sample);
    channels.set(sample.channel, rows);
  }
  return [...channels.values()].flatMap((rows) => diversifySamples(rows, limit));
}

function diversifySamples(samples, limit) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.source}:${sample.videoId}`;
    const rows = groups.get(key) || [];
    rows.push(sample);
    groups.set(key, rows);
  }
  const ordered = [...groups.values()]
    .map((rows) => rows.sort((left, right) => sampleQualityScore(right) - sampleQualityScore(left)))
    .sort((left, right) => sampleQualityScore(right[0]) - sampleQualityScore(left[0]));
  const output = [];
  let rowIndex = 0;
  while (output.length < limit) {
    let appended = false;
    for (const rows of ordered) {
      const row = rows[rowIndex];
      if (!row) continue;
      output.push(row);
      appended = true;
      if (output.length >= limit) break;
    }
    if (!appended) break;
    rowIndex += 1;
  }
  return output;
}

function buildCoverage(videos, samples) {
  const channels = ["douyin_comment", "bilibili_comment", "bilibili_danmaku"];
  return channels.map((channel) => {
    const rows = samples.filter((sample) => sample.channel === channel);
    const topicCounts = new Map();
    for (const row of rows) {
      for (const topic of row.topics || ["general"]) topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
    return {
      channel,
      videoCount: new Set(rows.map((row) => row.videoId)).size,
      sampleCount: rows.length,
      benchmarkSampleCount: rows.filter((row) => row.source === "benchmark").length,
      topics: [...topicCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([topic, count]) => ({ topic, count }))
    };
  });
}

function buildBenchmarkQuality(videos, samples) {
  const bilibiliVideos = videos.filter((video) => video.platform === "bilibili" && video.source === "benchmark");
  return {
    bilibili: {
      videoCount: bilibiliVideos.length,
      digitalVideoCount: bilibiliVideos.filter((video) => isDigitalBenchmarkText(video.videoTitle)).length,
      accountCount: new Set(bilibiliVideos.map((video) => normalizeAccountName(video.accountName))).size,
      commentSampleCount: samples.filter((sample) => sample.channel === "bilibili_comment" && sample.source === "benchmark").length,
      rejectedCommentCount: bilibiliVideos.reduce((total, video) => total + toFiniteNumber(video.commentRejectedCount), 0)
    }
  };
}

function validateRemoteBenchmarkCoverage(remote) {
  const bilibiliComments = remote.samples.filter((sample) => sample.channel === "bilibili_comment");
  const bilibiliCommentVideos = new Set(bilibiliComments.map((sample) => sample.videoId));
  const digitalCommentVideos = new Set(
    bilibiliComments
      .filter((sample) => isDigitalBenchmarkText(sample.videoTitle))
      .map((sample) => sample.videoId)
  );
  const minimumCommentVideos = Math.min(BILIBILI_VIDEO_LIMIT, Math.max(4, Math.floor(BILIBILI_VIDEO_LIMIT * 0.8)));
  const minimumDigitalVideos = Math.min(
    minimumCommentVideos,
    Math.max(3, Math.floor(BILIBILI_VIDEO_LIMIT * BILIBILI_DIGITAL_VIDEO_SHARE * 0.8))
  );
  if (bilibiliCommentVideos.size < minimumCommentVideos || digitalCommentVideos.size < minimumDigitalVideos) {
    throw new Error(
      `B站标杆刷新覆盖不足：评论区 ${bilibiliCommentVideos.size}/${minimumCommentVideos}，`
      + `数码评论区 ${digitalCommentVideos.size}/${minimumDigitalVideos}。可能触发了 B站临时限流，已保留上一份缓存。`
    );
  }
}

function inferTopics(value) {
  const text = normalizeText(value).toLowerCase();
  const topics = [];
  const rules = [
    ["digital_ai", /ai|人工智能|数码|手机|电脑|硬件|软件|键盘|鼠标|耳机|相机|摄像头|机器人|效率工具|工作流|app|芯片/],
    ["gaming", /游戏|玩家|电竞|steam|主机|手游|版本|角色|地图|副本|cs2|英雄联盟|原神/],
    ["workplace", /职场|上班|打工|办公|会议|同事|老板|简历|工作|效率|副业/],
    ["food", /美食|吃|餐厅|小吃|料理|做饭|探店|咖啡|饮料/],
    ["auto", /汽车|新车|试驾|车主|续航|智驾|油耗|电车|suv/],
    ["home", /家居|装修|收纳|家具|家电|清洁|租房|好物/],
    ["beauty", /美妆|护肤|口红|粉底|穿搭|发型|香水/],
    ["education", /学习|课程|考试|大学|知识|科普|教程|英语|数学/],
    ["entertainment", /电影|电视剧|综艺|明星|动画|动漫|音乐|演唱会/],
    ["social_news", /新闻|热点|社会|国际|网友|事件|政策|舆论/],
    ["lifestyle", /生活|旅行|日常|vlog|情侣|家庭|宠物|健康|运动/]
  ];
  for (const [topic, pattern] of rules) {
    if (pattern.test(text)) topics.push(topic);
  }
  return topics.length ? topics : ["general"];
}

function inferContentTypes(value) {
  const text = normalizeText(value).toLowerCase();
  const types = [];
  const rules = [
    ["review", /测评|评测|体验|上手|值不值|对比|开箱|实测/],
    ["commercial", /商单|合作|优惠|新品|首发|到手|购买|品牌|限时|推荐/],
    ["tutorial", /教程|怎么|指南|技巧|入门|教学|实战/],
    ["news", /新闻|热点|速报|发布|官宣|事件|回应/],
    ["story", /故事|记录|一天|经历|挑战|vlog/],
    ["discussion", /如何看|聊聊|为什么|到底|争议|吐槽/]
  ];
  for (const [type, pattern] of rules) {
    if (pattern.test(text)) types.push(type);
  }
  return types.length ? types : ["general"];
}

function parseBilibiliQueries(raw) {
  const defaults = [
    { topic: "digital_ai", query: "手机测评" },
    { topic: "digital_ai", query: "旗舰手机横评" },
    { topic: "digital_ai", query: "电脑硬件评测" },
    { topic: "digital_ai", query: "笔记本电脑评测" },
    { topic: "digital_ai", query: "显卡横评" },
    { topic: "digital_ai", query: "相机深度评测" },
    { topic: "digital_ai", query: "手机影像评测" },
    { topic: "digital_ai", query: "耳机横评" },
    { topic: "digital_ai", query: "智能穿戴评测" },
    { topic: "digital_ai", query: "AI硬件体验" },
    { topic: "digital_ai", query: "数码翻车" },
    { topic: "digital_ai", query: "智能家居评测" },
    { topic: "workplace", query: "效率工具" },
    { topic: "gaming", query: "游戏评测" },
    { topic: "food", query: "美食探店" },
    { topic: "auto", query: "汽车测评" },
    { topic: "home", query: "家居好物" },
    { topic: "lifestyle", query: "生活记录" }
  ];
  if (!raw?.trim()) return defaults;
  return raw.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [topic, ...queryParts] = entry.split(":");
      const query = queryParts.join(":").trim();
      return query ? { topic: topic.trim() || "general", query } : { topic: "general", query: topic.trim() };
    });
}

function parseBilibiliPreferredAccounts(raw) {
  const defaults = [
    "极客湾Geekerwan",
    "影视飓风",
    "差评君",
    "小白测评",
    "笔吧评测室",
    "硬件茶谈",
    "老师好我叫何同学",
    "科技美学",
    "爱否科技FView",
    "先看评测",
    "TESTV官方频道",
    "凰家评测",
    "Linksphotograph",
    "嗨-视听"
  ];
  return uniqueText(raw?.trim() ? raw.split(",") : defaults).map(normalizeAccountName);
}

function parseDouyinAccounts(raw) {
  const defaults = [
    { name: "老青椒", secUid: "MS4wLjABAAAAOs9uAAePTfG9iTTfzimMGBvJKgdafNDJIdlwwEoLW5Q" },
    { name: "呼叫网管", secUid: "MS4wLjABAAAAAtnCpevF0YXW29cXbyJmXnSyq6qZL-PdV2x8Cl6PQpw" },
    { name: "老油条说", secUid: "MS4wLjABAAAA_0jM7cf6AxPFN0YXipaK0UDklzNWI7jBuv5da096erU" }
  ];
  if (!raw?.trim()) return defaults;
  return raw.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return separator > 0
        ? { name: entry.slice(0, separator).trim(), secUid: entry.slice(separator + 1).trim() }
        : null;
    })
    .filter((entry) => entry?.name && entry?.secUid);
}

function parseDouyinQueries(raw) {
  const defaults = [
    { topic: "digital_ai", query: "数码测评" },
    { topic: "workplace", query: "效率工具" },
    { topic: "gaming", query: "游戏评测" },
    { topic: "food", query: "美食探店" },
    { topic: "auto", query: "汽车测评" },
    { topic: "home", query: "家居好物" },
    { topic: "beauty", query: "美妆测评" },
    { topic: "lifestyle", query: "生活好物" }
  ];
  if (!raw?.trim()) return defaults;
  return raw.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [topic, ...queryParts] = entry.split(":");
      const query = queryParts.join(":").trim();
      return query ? { topic: topic.trim() || "general", query } : { topic: "general", query: topic.trim() };
    });
}

function normalizeStats(value) {
  const row = value && typeof value === "object" ? value : {};
  return {
    views: toFiniteNumber(row.views ?? row.view ?? row.play),
    likes: toFiniteNumber(row.likes ?? row.like ?? row.digg_count),
    comments: toFiniteNumber(row.comments ?? row.reply ?? row.comment_count),
    danmaku: toFiniteNumber(row.danmaku),
    shares: toFiniteNumber(row.shares ?? row.share ?? row.share_count)
  };
}

function videoQualityScore(video) {
  const stats = normalizeStats(video?.stats || video?.statistics || {});
  const comments = Array.isArray(video?.topComments) ? video.topComments.length : 0;
  const danmaku = Array.isArray(video?.danmakuSamples) ? video.danmakuSamples.length : 0;
  return Math.log10(stats.views + 10) * 2 + Math.log10(stats.likes + 10) * 3 + comments * 0.2 + danmaku * 0.05;
}

function bilibiliSearchRowQualityScore(row) {
  const accountName = normalizeAccountName(row?.author);
  const popularity = Math.log10(Math.max(0, toFiniteNumber(row?.score ?? row?.play)) + 10) * 10;
  return popularity + (isPreferredBilibiliAccount(accountName) ? 24 : 0);
}

function bilibiliCandidateQualityScore(candidate) {
  return Math.log10(Math.max(0, candidate.score) + 10) * 10
    + (isPreferredBilibiliAccount(candidate.accountName) ? 24 : 0)
    + Math.min(6, (candidate.discoverySources?.length || 0) * 2);
}

function selectBilibiliCandidates(candidates, limit) {
  const selected = [];
  const selectedIds = new Set();
  const accountCounts = new Map();
  const take = (pool, targetCount, enforceAccountLimit = true) => {
    for (const candidate of pool) {
      if (selected.length >= targetCount || selected.length >= limit) break;
      if (selectedIds.has(candidate.videoId)) continue;
      const accountKey = normalizeAccountName(candidate.accountName).toLowerCase();
      if (enforceAccountLimit && (accountCounts.get(accountKey) || 0) >= BILIBILI_ACCOUNT_VIDEO_LIMIT) continue;
      selected.push(candidate);
      selectedIds.add(candidate.videoId);
      accountCounts.set(accountKey, (accountCounts.get(accountKey) || 0) + 1);
    }
  };
  const digitalTarget = Math.min(limit, Math.round(limit * BILIBILI_DIGITAL_VIDEO_SHARE));
  take(candidates.filter((candidate) => isDigitalBenchmarkText(candidate.videoTitle)), digitalTarget);
  take(candidates, limit);
  take(candidates, limit, false);
  return selected;
}

function isPreferredBilibiliAccount(value) {
  const normalized = normalizeAccountName(value).toLowerCase();
  return BILIBILI_PREFERRED_ACCOUNTS.some((account) => {
    const preferred = account.toLowerCase();
    return normalized === preferred || normalized.includes(preferred) || preferred.includes(normalized);
  });
}

function isDigitalBenchmarkText(value) {
  return /数码(?:区|圈|产品|设备|测评|评测|科技|博主)|手机|平板|电脑|笔记本|显卡|处理器|芯片|主板|硬盘|内存|相机|镜头|摄影|耳机|音频|降噪|键盘|鼠标|显示器|路由器|nas|穿戴|手表|机器人|智能家居|ai\s*硬件|影像|iphone|macbook|安卓|鸿蒙|小米|华为|荣耀|vivo|oppo|索尼|佳能|尼康|大疆|rtx|cpu|gpu/i.test(normalizeText(value));
}

function isBilibiliSeoFarmTitle(value) {
  const text = normalizeText(value);
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
  return markers.filter((pattern) => pattern.test(text)).length >= 2;
}

function isBilibiliBenchmarkCommentNoise(value) {
  const text = normalizeText(value);
  return /(?:抽奖|开奖|中奖|欧气|读到这条).{0,16}(?:中奖|好运|欧气|抽|送)/i.test(text)
    || /(?:三连|关注|点赞|投币).{0,16}(?:抽|送|中奖|福利)/i.test(text)
    || /(?:抽|送)\s*\d{1,4}\s*(?:台|部|个|份|套).{0,18}(?:iphone|手机|耳机|奖|福利)?/i.test(text)
    || /(?:咱|本)(?:店|直播间)|店里逛逛|点击购买|购买链接|联系客服/i.test(text);
}

function sampleQualityScore(sample) {
  return (sample.source === "benchmark" ? 2 : 0)
    + Math.log10(Math.max(0, sample.likes) + 1) * 2
    + Math.log10(Math.max(0, sample.replies) + 1)
    + (sample.rank > 0 ? 1 / sample.rank : 0);
}

function deterministicSample(values, limit, keyOf) {
  if (values.length <= limit) return values;
  return values
    .map((value) => ({ value, score: stableHash(keyOf(value)) }))
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map((item) => item.value);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeSampleText(value) {
  const text = normalizeText(value);
  const length = Array.from(text).length;
  return length >= 2 && length <= 140 ? text : "";
}

function normalizeText(value) {
  return String(value || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function normalizeAccountName(value) {
  return normalizeText(value).replace(/\s*\(mid:\s*\d+\)\s*$/i, "") || "未知账号";
}

function accountNameFromVideoPath(filePath) {
  return path.basename(path.dirname(path.dirname(filePath)));
}

function parseDurationSec(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number.parseFloat(text);
  const colon = text.match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (colon) return (Number(colon[1] || 0) * 3600) + (Number(colon[2]) * 60) + Number(colon[3]);
  const seconds = text.match(/\((\d+)s\)/i);
  return seconds ? Number(seconds[1]) : 0;
}

function extractBvid(value) {
  return String(value || "").match(/BV[0-9A-Za-z]{10}/i)?.[0] || "";
}

function extractDouyinVideoId(value) {
  return String(value || "").match(/(?:video\/|modal_id=)?(\d{8,})/i)?.[1] || "";
}

function decodeXmlText(value) {
  return normalizeText(String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&"));
}

function commentFingerprint(value) {
  return normalizeText(value).replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "").toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clampRate(value, min, max, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function toFiniteNumber(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueBy(values, keyOf) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueText(values) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function formatError(error) {
  if (error instanceof Error) return error.message.replace(/\s+/g, " ").trim().slice(0, 500);
  return String(error || "未知错误").replace(/\s+/g, " ").trim().slice(0, 500);
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
