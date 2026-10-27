import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { openCliRows, parseJsonish } from "../src/lib/opencli-runtime";
import { buildDouyinBatchStatsExtractJs } from "../src/lib/opencli-douyin-scripts";
import { assertPublicHttpUrl } from "../src/lib/public-http-url";
import type { BatchTranscribeInput } from "../src/lib/batch-transcribe";
import type { CollectAccountInput } from "../src/lib/account-collection";
import type { Account, BatchTranscribeResult, CollectResult, Video } from "../src/lib/types";
import type { transcribeVideo } from "../src/lib/transcription";

const require = createRequire(import.meta.url);
// Only builtin utilities are real; storage, processes and network capabilities are injected.
function load<T>(file: string, mocks: Record<string, unknown>, extra = "", env = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8") + "\n" + extra, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, { exports, Buffer, Error, process: { env }, AbortSignal, URL, console,
    require: (name: string) => mocks[name] ?? (["util", "path", "os", "crypto", "net"].includes(name) ? require(name) : {})
  });
  return exports as T;
}

const account = { id: "bilibili:test", slug: "test", platform: "bilibili", name: "测试", uid: "123" } as Account;
const video = (id: string, completed = false): Video => ({
  id, accountId: account.id, platform: "bilibili", title: id, url: `https://example.com/${id}`,
  publishedAt: "2025-01-01", stats: { views: 10, likes: 5, comments: 3, favorites: 2 },
  hotScore: 0, relativeViewRate: 0,
  transcriptStatus: completed ? "completed" : "not_started", updatedAt: "2025-01-01"
});

test("显式批量 IDs 先去重并筛选未转写项，再应用上限", async () => {
  const called: string[] = [];
  const videos = [video("done", true), video("a"), video("b")];
  const batch = load<{ runBatchTranscribe(input: BatchTranscribeInput): Promise<BatchTranscribeResult> }>("src/lib/batch-transcribe.ts", {
    "./storage": { resolveAccount: async () => account, getAccountSummary: async () => ({ ...account, videos }) },
    "./transcription": { transcribeVideo: async ({ videoId }: { videoId: string }) => { called.push(videoId); return { video: video(videoId, true), usedProvider: "stub" }; } }
  });
  const result = await batch.runBatchTranscribe({ platform: "bilibili", accountId: account.id, limit: 1, videoIds: ["done", "a", "a", "b"] });
  assert.equal(result.requested, 1);
  assert.deepEqual(called, ["a"]);
  await assert.rejects(batch.runBatchTranscribe({ platform: "bilibili", accountId: account.id, limit: 1, videoIds: ["foreign"] }), /不属于当前账号/);
});

test("B站日期分页大小固定，只有截止日期时继续读取历史页", async () => {
  const calls: Array<{ page?: number; limit: number; hydrateDetails: boolean }> = [];
  const collection = load<{ collectAccountContent(input: CollectAccountInput): Promise<CollectResult> }>("src/lib/account-collection.ts", {
    "./opencli": { resolveAccountUid: async () => "123", collectVideos: async (input: typeof calls[number]) => {
      calls.push(input);
      return { videos: (input.page || 1) <= 2 ? [video(String(input.page || 1))] : [], raw: [], rawCount: 1, command: "stub" };
    } },
    "./platform-links": { normalizeLinkInput: (value: string) => value, extractFirstLinkFromInput: () => "" },
    "./account-profile": { inferAccountNameFromCollectedData: () => "测试", inferAccountAvatarFromCollectedData: () => "avatar" },
    "./storage": { upsertAccount: async () => account, getAccountSummary: async () => ({ ...account, videos: [] }), saveVideos: async (_account: Account, videos: Video[]) => videos },
    "./utils": { nowIso: () => "2025-01-01", shortHash: () => "hash" }
  });
  const result = await collection.collectAccountContent({ platform: "bilibili", name: "测试", uidOrUrl: "123", limit: 1, order: "comments", toDate: "2025-12-31" });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.limit === 50 && call.hydrateDetails));
  assert.equal(result.videos.length, 1);
});

test("本地 ASR 保存冲突保留 409 且不标记旧稿失败", async () => {
  let marked = 0;
  const conflict = Object.assign(new Error("冲突"), { statusCode: 409 });
  const transcription = load<{ transcribeVideo: typeof transcribeVideo }>("src/lib/transcription.ts", {
    child_process: { execFile: () => { throw new Error("禁止真实进程"); } },
    fs: { promises: { rm: async () => {} } },
    "./storage": { getVideo: async () => ({ account, video: video("a", true) }), getTranscriptSnapshot: async () => ({ revision: "old" }), saveTranscript: async () => { throw conflict; }, markTranscriptFailed: async () => { marked++; } },
    "./transcript-cleaning": { cleanTranscriptText: async () => ({ text: "新稿" }) }
  }, "prepareAudioForVolcengine = async () => ({ mediaPath: '/virtual.wav', timings: [] }); transcribeWithVolcengine = async () => ({ text: '新稿', timings: [] });");
  await assert.rejects(transcription.transcribeVideo({ platform: "douyin", accountId: "test", videoId: "a", mediaPath: "/virtual.wav" }), (error) => error === conflict);
  assert.equal(marked, 0);
});

test("OpenCLI 非列表结果显式失败，真实空列表保持兼容", () => {
  for (const raw of ["session expired", {}, { data: "error" }, null]) assert.throws(() => openCliRows(raw), /无法解析/);
  assert.deepEqual(openCliRows(parseJsonish("[]")), []);
  assert.deepEqual(openCliRows({ data: [] }), []);
});

test("抖音详情缺字段显式返回 missingFields，真实零值不算缺失", async () => {
  const rows = await vm.runInNewContext(buildDouyinBatchStatsExtractJs(["1", "2"]), {
    URL, fetch: async (url: string) => ({ ok: true, json: async () => ({ aweme_detail: { statistics: new URL(url).searchParams.get("aweme_id") === "1"
      ? { digg_count: 5 } : { digg_count: 0, comment_count: 0, collect_count: 0, share_count: 0 } } }) })
  });
  assert.deepEqual(Array.from(rows[0].missingFields), ["comment_count", "collect_count", "share_count"]);
  assert.equal(rows[1].missingFields.length, 0);
});

test("媒体边界拒绝非 HTTP 协议及 IPv4/IPv6 内网，不发出下载", async () => {
  for (const url of ["file:///private/audio.wav", "http://127.0.0.1/a", "http://10.0.0.1/a", "http://localhost/a", "http://[::1]/a", "http://[::ffff:127.0.0.1]/a", "http://100.64.0.1/a"]) {
    await assert.rejects(assertPublicHttpUrl(url), (error) => error instanceof Error && "statusCode" in error && error.statusCode === 400);
  }
});

function subtitleClient(reply: (lang: string) => unknown, calls: string[] = []) {
  return load<{ getBilibiliSubtitle(video: Video, options?: { signal?: AbortSignal }): Promise<string> }>("src/lib/opencli-bilibili.ts", {
    "./platform-links": { extractBvid: () => "BV1xx411c7mD" },
    "./opencli-runtime": { openCliRows, parseJsonish, runPersistentOpenCliBrowserAdapter: async (args: string[]) => {
      const lang = args[args.indexOf("--lang") + 1];
      calls.push(lang);
      return JSON.stringify(reply(lang));
    } }
  });
}

test("B站缺少标题也拒收英文轨道，继续寻找 ai-zh 中文轨道", async () => {
  const calls: string[] = [];
  const client = subtitleClient((lang) => [{ language: lang === "ai-zh" ? "ai-zh" : "en-US", content: lang === "ai-zh" ? "原视频的中文内容" : "English translation" }], calls);
  assert.equal(await client.getBilibiliSubtitle({ url: "https://www.bilibili.com/video/BV1xx411c7mD" } as Video), "原视频的中文内容");
  assert.deepEqual(calls, ["zh-CN", "ai-zh"]);
});

test("B站实际中文轨道优先采用；繁体中文和短字幕不依赖标题或字数", async () => {
  for (const language of ["zh-CN", "ai-zh", "zh-TW", "zh-Hant"]) {
    const calls: string[] = [];
    const client = subtitleClient(() => [{ language, content: "好" }], calls);
    assert.equal(await client.getBilibiliSubtitle(video("English title")), "好");
    assert.equal(calls.length, 1);
  }
});

test("B站全英文、语言缺失或混杂均显式拒收，中文标题不能掩盖轨道语言", async () => {
  for (const rows of [
    [{ language: "en-US", content: "中文也不能覆盖轨道标记" }],
    [{ content: "未标注语言的字幕" }],
    [{ language: "zh-CN", content: "中文" }, { language: "en-US", content: "English" }]
  ]) {
    await assert.rejects(subtitleClient(() => rows).getBilibiliSubtitle(video("中文标题")), /未作为中文字幕使用/);
  }
  assert.equal(await subtitleClient(() => []).getBilibiliSubtitle(video("无字幕")), "");
});

function linkTranscriptionFixture(options: { empty?: boolean; failAsr?: boolean; cleaningFallback?: boolean } = {}) {
  const calls: string[] = [];
  const client = subtitleClient(() => options.empty ? [] : [{ language: "en-US", content: "English subtitle" }]);
  const transcription = load<{ transcribeLinkSource: typeof import("../src/lib/transcription").transcribeLinkSource }>("src/lib/transcription.ts", {
    child_process: { execFile: () => { throw new Error("禁止真实进程"); } },
    fs: { promises: { rm: async () => { calls.push("cleanup"); } } },
    "./opencli": { getBilibiliSubtitle: client.getBilibiliSubtitle },
    "./platform-links": { detectPlatformFromLink: () => "bilibili" },
    "./transcript-cleaning": { cleanTranscriptText: async ({ text }: { text: string }) => ({ text, fallback: Boolean(options.cleaningFallback), fallbackReason: options.cleaningFallback ? "清洗失败，保留识别原文" : undefined }) },
    "fixture": { calls, failAsr: options.failAsr }
  }, `
    const fixture = require("fixture");
    resolveShareUrl = async (url) => url;
    resolveLinkMediaUrl = async () => ({ title: '视频标题', mediaUrls: ['https://example.com/audio'], mediaId: 'test' });
    downloadFirstAvailableRemoteAudio = async () => { fixture.calls.push('download'); return { mediaPath: '/virtual.mp3', ms: 1, attempts: [] }; };
    prepareAudioForVolcengine = async () => ({ mediaPath: '/virtual.mp3', timings: [] });
    transcribeWithVolcengine = async () => { fixture.calls.push('asr'); if (fixture.failAsr) throw new Error('识别服务不可用'); return { text: '从原视频音频识别的中文内容', timings: [] }; };
  `);
  return { ...transcription, calls };
}

test("单条链接收到英文仍下载原音频转写，并合并字幕降级和清洗降级说明", async () => {
  for (const options of [{}, { empty: true }, { cleaningFallback: true }]) {
    const fixture = linkTranscriptionFixture(options);
    const result = await fixture.transcribeLinkSource({ url: "https://www.bilibili.com/video/BV1xx411c7mD" });
    assert.equal(result.source, "volcengine");
    assert.equal(result.text, "从原视频音频识别的中文内容");
    assert.equal(result.fallback, true);
    assert.match(result.fallbackReason || "", /中文字幕不可用，已改为识别原视频音频/);
    if ("cleaningFallback" in options) assert.match(result.fallbackReason || "", /清洗失败/);
    assert.deepEqual(fixture.calls, ["download", "asr", "cleanup"]);
  }
});

test("字幕语言不符且音频识别失败时显式失败，不返回英文假成功", async () => {
  const fixture = linkTranscriptionFixture({ failAsr: true });
  await assert.rejects(fixture.transcribeLinkSource({ url: "https://www.bilibili.com/video/BV1xx411c7mD" }), /音频转写也失败：识别服务不可用/);
  assert.deepEqual(fixture.calls, ["download", "asr", "cleanup"]);
});

test("B站字幕请求取消后不继续尝试轨道", async () => {
  const controller = new AbortController();
  let calls = 0;
  const cancelled = new Error("任务已停止");
  const client = load<{ getBilibiliSubtitle(video: Video, options: { signal: AbortSignal }): Promise<string> }>("src/lib/opencli-bilibili.ts", {
    "./platform-links": { extractBvid: () => "BV1xx411c7mD" },
    "./opencli-runtime": { runPersistentOpenCliBrowserAdapter: async () => { calls++; controller.abort(); throw cancelled; } }
  });
  await assert.rejects(client.getBilibiliSubtitle(video("测试"), { signal: controller.signal }), (error) => error === cancelled);
  assert.equal(calls, 1);
});

const screenshotTranscript = "Me, baby, I'm a sugar Sara, bring a spoon for the senate. free Looking for a.";

function realCleaner() {
  return load<{ cleanTranscriptText: typeof import("../src/lib/transcript-cleaning").cleanTranscriptText }>("src/lib/transcript-cleaning.ts", {
    "./pi-runtime": { piEnabled: () => false }
  });
}

test("中文标题下的纯英文识别在模型清洗之前拒收，短句与中英混排不误杀", async () => {
  const { cleanTranscriptText } = realCleaner();
  await assert.rejects(cleanTranscriptText({ platform: "bilibili", title: "再三对比后，还得是大疆Pocket 4！", text: screenshotTranscript, useModel: true }), /转写结果语言待核实/);
  for (const text of ["大疆 Pocket 4 支持 4K，DJI 的 Active Track 很好用。", "好", "DJI Pocket 4", "繁體中文測試"]) {
    assert.ok((await cleanTranscriptText({ platform: "bilibili", title: "中文标题", text })).text);
  }
  assert.equal((await cleanTranscriptText({ platform: "douyin", title: "English speech", text: "This is an English speech." })).text, "This is an English speech.");
  for (const text of ["", "   ", "🎵 BGM ♪"]) {
    await assert.rejects(cleanTranscriptText({ platform: "bilibili", text }), /没有识别到可用的转写正文/);
  }
});

test("账号库重转写遇到截图英文结果时不调用保存，保留旧稿及 revision", async () => {
  for (const source of ["asr", "subtitle"]) {
    let saved = 0;
    const errors: string[] = [];
    const transcription = load<{ transcribeVideo: typeof transcribeVideo }>("src/lib/transcription.ts", {
      child_process: { execFile: () => { throw new Error("禁止真实进程"); } },
      fs: { promises: { rm: async () => {} } },
      "./opencli": { getBilibiliSubtitle: async () => source === "subtitle" ? screenshotTranscript : "" },
      "./storage": {
        getVideo: async () => ({ account, video: video("中文视频", true) }),
        getTranscriptSnapshot: async () => ({ revision: "old" }),
        saveTranscript: async () => { saved++; throw new Error("不得覆盖旧稿"); },
        markTranscriptFailed: async (_p: string, _a: string, _v: string, reason: string) => { errors.push(reason); }
      },
      "./transcript-cleaning": realCleaner(),
      fixture: { text: screenshotTranscript }
    }, `prepareAudioForVolcengine = async () => ({ mediaPath: '/virtual.mp3', timings: [] });
        transcribeWithVolcengine = async () => ({ text: require('fixture').text, timings: [] });`);
    await assert.rejects(transcription.transcribeVideo({ platform: "bilibili", accountId: "test", videoId: "a", mediaPath: "/virtual.mp3" }), /转写结果语言待核实/);
    assert.equal(saved, 0);
    if (source === "asr") assert.match(errors[0], /转写结果语言待核实/);
  }
});

test("单条链接的音频识别与字幕均不能把中文标题下的英文当作成功正文", async () => {
  for (const source of ["asr", "subtitle"]) {
    const transcription = load<{ transcribeLinkSource: typeof import("../src/lib/transcription").transcribeLinkSource }>("src/lib/transcription.ts", {
      child_process: { execFile: () => { throw new Error("禁止真实进程"); } },
      fs: { promises: { rm: async () => {} } },
      "./opencli": { getBilibiliSubtitle: async () => source === "subtitle" ? screenshotTranscript : "" },
      "./platform-links": { detectPlatformFromLink: () => "bilibili" },
      "./transcript-cleaning": realCleaner(),
      fixture: { text: screenshotTranscript }
    }, `resolveShareUrl = async (url) => url;
        resolveLinkStatsMetadata = async () => ({ title: '中文视频' });
        resolveLinkMediaUrl = async () => ({ title: '中文视频', mediaUrls: ['https://example.com/audio'] });
        downloadFirstAvailableRemoteAudio = async () => ({ mediaPath: '/virtual.mp3', ms: 1, attempts: [] });
        prepareAudioForVolcengine = async () => ({ mediaPath: '/virtual.mp3', timings: [] });
        transcribeWithVolcengine = async () => ({ text: require('fixture').text, timings: [] });`);
    await assert.rejects(transcription.transcribeLinkSource({ url: "https://www.bilibili.com/video/BV1MG5Y65E6w" }), /转写结果语言待核实/);
  }
});

test("清洗模型把中文变成英文时保留识别原文并显式报告降级", async () => {
  const cleaner = load<{ cleanTranscriptText: typeof import("../src/lib/transcript-cleaning").cleanTranscriptText }>("src/lib/transcript-cleaning.ts", {
    "./pi-runtime": { piEnabled: () => false },
    "./ai": { getChatRuntimeConfig: () => ({ configured: true }), chatComplete: async () => ({ ok: true, text: screenshotTranscript, model: "test-model" }) }
  });
  const result = await cleaner.cleanTranscriptText({ platform: "bilibili", title: "中文视频", text: "这是原始中文口播。", useModel: true });
  assert.equal(result.text, "这是原始中文口播。");
  assert.equal(result.fallback, true);
  assert.match(result.fallbackReason || "", /转写结果语言待核实/);
});
