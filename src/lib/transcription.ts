import { getDouyinSingleVideoReference } from "./opencli-douyin-detail";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { assertPublicHttpUrl, downloadPublicHttpMedia } from "./public-http-url";
import {
  buildOpenCliBrowserArgs,
  downloadBilibiliVideo,
  getBilibiliPublicVideoReference,
  getBilibiliVideoStatsByUrl,
  getBilibiliVideoReference,
  checkDouyinVideoAvailability,
  getBilibiliSubtitle,
  getDouyinVideoStatsByUrl,
  parseOpenCliJsonish,
  refreshDouyinVideoDownloadUrl,
} from "./opencli";
import {
  browserUserAgent,
  buildDouyinVideoUrl,
  buildRemoteAssetRequestHeaders,
  detectPlatformFromLink,
  extractBvid,
  extractDouyinAwemeId,
  inferRemoteContentType,
  inferRemoteFileExtension,
  isLikelyAudioMediaUrl,
  normalizeRemoteImageUrl,
  sortRemoteAudioMediaUrls,
  videoMediaUrlScore
} from "./platform-links";
import { runOpenCli, withSharedOpenCliBrowserSession } from "./opencli-runtime";
import { getTranscriptSnapshot, getVideo, markTranscriptFailed, saveTranscript } from "./storage";
import { cleanTranscriptText } from "./transcript-cleaning";
import { Account, Platform, Video } from "./types";

const HIDDEN_CHILD_PROCESS_OPTIONS = { windowsHide: true };
const execFileAsync = promisify(execFile);
type Timing = { stage: string; ms: number };
type AbortableOptions = {
  signal?: AbortSignal;
};

export type LinkTranscriptionResult = {
  url: string;
  resolvedUrl?: string;
  platform: Platform | "unknown";
  title?: string;
  sourceAccountName?: string;
  coverUrl?: string;
  mediaUrls?: string[];
  text: string;
  source: "platform_subtitle" | "volcengine" | "metadata";
  metadataTitle?: string;
  fallback?: boolean;
  fallbackReason?: string;
  durationSec?: number;
  segments?: Array<{
    startSec: number;
    endSec: number;
    text: string;
  }>;
  timings?: Timing[];
};

type LinkMediaInfo = {
  mediaId?: string;
  title?: string;
  sourceAccountName?: string;
  coverUrl?: string;
  mediaUrls: string[];
};

export type LinkSourceAssetKind = "video" | "cover" | "audio";

export type LinkSourceResolvedMedia = {
  url: string;
  resolvedUrl?: string;
  platform: Platform | "unknown";
  title?: string;
  sourceAccountName?: string;
  coverUrl?: string;
  mediaUrls: string[];
};

export type LinkSourceDownloadAsset = {
  kind: LinkSourceAssetKind;
  fileName: string;
  contentType: string;
  filePath?: string;
  remoteUrl?: string;
  requestHeaders?: Record<string, string>;
  cleanupTargets?: string[];
};

function transcriptionConfig() {
  const pollIntervalMs = Number.parseInt(process.env.VOLCENGINE_ASR_POLL_INTERVAL_MS || "", 10);
  const maxPollAttempts = Number.parseInt(process.env.VOLCENGINE_ASR_MAX_POLL_ATTEMPTS || "", 10);
  const timeoutMs = Number.parseInt(process.env.VOLCENGINE_ASR_REQUEST_TIMEOUT_MS || "", 10);
  const retryCount = Number.parseInt(process.env.VOLCENGINE_ASR_RETRY_COUNT || "", 10);

  return {
    apiKey: process.env.VOLCENGINE_ASR_API_KEY || process.env.VOLCENGINE_API_KEY || "",
    appKey: process.env.VOLCENGINE_ASR_APP_KEY || "",
    accessKey: process.env.VOLCENGINE_ASR_ACCESS_KEY || "",
    uid: process.env.VOLCENGINE_ASR_UID || "",
    resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID || "volc.seedasr.auc",
    submitUrl:
      process.env.VOLCENGINE_ASR_SUBMIT_URL ||
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
    queryUrl:
      process.env.VOLCENGINE_ASR_QUERY_URL ||
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
    audioFormat: normalizeVolcengineAudioFormat(process.env.VOLCENGINE_ASR_AUDIO_FORMAT),
    pollIntervalMs: Number.isFinite(pollIntervalMs) ? Math.max(pollIntervalMs, 500) : 1000,
    maxPollAttempts: Number.isFinite(maxPollAttempts) ? Math.max(maxPollAttempts, 1) : 120,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(timeoutMs, 5000) : 30000,
    retryCount: Number.isFinite(retryCount) ? Math.max(0, Math.min(retryCount, 3)) : 2
  };
}

export async function transcribeVideo(input: {
  platform: Platform;
  accountId: string;
  videoId: string;
  mediaPath?: string;
  mediaUrl?: string;
  douyinMediaUrl?: string;
  allowRemoteDownload?: boolean;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  for (const url of [input.mediaUrl, input.douyinMediaUrl].filter(Boolean) as string[]) await assertPublicHttpUrl(url);
  const timings: Timing[] = [];
  const totalStartedAt = Date.now();
  const { account, video } = await getVideo(input.platform, input.accountId, input.videoId);
  const transcriptSnapshot = await getTranscriptSnapshot(input.platform, input.accountId, input.videoId);
  timings.push({ stage: "load-video", ms: Date.now() - totalStartedAt });
  const cleanupTargets: string[] = [];
  let hadBilibiliSubtitle = false;
  let bilibiliSubtitleError = "";

  if (input.platform === "bilibili") {
    let subtitle = "";
    try {
      subtitle = await getBilibiliSubtitle(video, { signal: input.signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      bilibiliSubtitleError = formatErrorDetail(error);
    }
    throwIfAborted(input.signal);
    if (subtitle.trim()) {
      hadBilibiliSubtitle = true;
      const cleaned = await cleanTranscriptText({
        platform: input.platform,
        title: video.title,
        text: subtitle,
        signal: input.signal
      });
      throwIfAborted(input.signal);
      return {
        ...(await saveTranscript({
          platform: input.platform,
          accountId: input.accountId,
          videoId: input.videoId,
          text: cleaned.text,
          source: "platform_subtitle",
          expectedRevision: transcriptSnapshot.revision
        })),
        usedProvider: "bilibili-subtitle",
        transcriptCleaning: {
          fallback: cleaned.fallback,
          fallbackReason: cleaned.fallbackReason,
          usedModel: cleaned.usedModel
        }
      };
    }
  }

  let mediaPath = input.mediaPath || "";
  let mediaError = "";

  try {
    throwIfAborted(input.signal);
    const shouldDownloadRemote =
      input.allowRemoteDownload || (input.platform === "douyin" && Boolean(input.douyinMediaUrl));
    if (!mediaPath && shouldDownloadRemote) {
      if (input.platform === "bilibili") {
        try {
          const prepared = await downloadBilibiliAudio(video, { signal: input.signal });
          mediaPath = prepared.mediaPath;
          timings.push(...prepared.timings);
          cleanupTargets.push(...prepared.cleanupTargets);
        } catch (error) {
          if (isAbortError(error)) throw error;
          mediaError = error instanceof Error ? error.message : "B站音频提取失败";
        }
      } else {
        try {
          const prepared = await downloadDouyinAudio(account, video, input.douyinMediaUrl, {
            signal: input.signal
          });
          mediaPath = prepared.mediaPath;
          timings.push(...prepared.timings);
          cleanupTargets.push(mediaPath);
        } catch (error) {
          if (isAbortError(error)) throw error;
          mediaError = error instanceof Error ? error.message : "下载音频失败";
        }
      }
    }

    if (!mediaPath && input.mediaUrl) {
      try {
        throwIfAborted(input.signal);
        const prepared = await downloadRemoteAudio(input.mediaUrl, `${input.videoId}.mp3`, {
          signal: input.signal
        });
        mediaPath = prepared.mediaPath;
        timings.push({ stage: "download-media-url-audio", ms: prepared.ms });
        cleanupTargets.push(mediaPath);
      } catch (error) {
        if (isAbortError(error)) throw error;
        mediaError = error instanceof Error ? error.message : "下载音频失败";
      }
    }

    if (!mediaPath) {
      if (input.platform === "douyin") {
        const availability = await checkDouyinVideoAvailability(account, video, { signal: input.signal });
        if (availability.visible === false) {
          const reason = `没有取得可转写媒体地址：${availability.reason}`;
          await markTranscriptFailed(input.platform, input.accountId, input.videoId, reason);
          throw new Error(reason);
        }
        if (availability.visible === true && availability.reason) {
          mediaError = mediaError ? `${mediaError}；${availability.reason}` : availability.reason;
        }
      }
      const reason = buildMissingMediaReason({
        platform: input.platform,
        mediaError,
        hadBilibiliSubtitle,
        bilibiliSubtitleError
      });
      await markTranscriptFailed(input.platform, input.accountId, input.videoId, reason);
      throw new Error(reason);
    }

    try {
      throwIfAborted(input.signal);
      const transcribeStartedAt = Date.now();
      const preparedForAsr = await prepareAudioForVolcengine(mediaPath, { signal: input.signal });
      if (preparedForAsr.cleanupPath) cleanupTargets.push(preparedForAsr.cleanupPath);
      timings.push(...preparedForAsr.timings);
      const volcengine = await transcribeWithVolcengine(preparedForAsr.mediaPath, { signal: input.signal });
      const text = volcengine.text;
      timings.push(...volcengine.timings);
      timings.push({ stage: "volcengine-transcribe", ms: Date.now() - transcribeStartedAt });
      throwIfAborted(input.signal);
      const cleanStartedAt = Date.now();
      const cleaned = await cleanTranscriptText({
        platform: input.platform,
        title: video.title,
        text,
        signal: input.signal
      });
      timings.push({ stage: "clean-transcript", ms: Date.now() - cleanStartedAt });
      const saveStartedAt = Date.now();
      throwIfAborted(input.signal);
      const saved = await saveTranscript({
        platform: input.platform,
        accountId: input.accountId,
        videoId: input.videoId,
        text: cleaned.text,
        source: "volcengine",
        expectedRevision: transcriptSnapshot.revision
      });
      timings.push({ stage: "save-transcript", ms: Date.now() - saveStartedAt });
      return {
        ...saved,
        usedProvider: "volcengine",
        timings: [...timings, { stage: "total", ms: Date.now() - totalStartedAt }],
        transcriptCleaning: {
          fallback: cleaned.fallback,
          fallbackReason: cleaned.fallbackReason,
          usedModel: cleaned.usedModel
        }
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 409) throw error;
      const reason = buildProviderErrorReason(input.platform, error, bilibiliSubtitleError);
      await markTranscriptFailed(input.platform, input.accountId, input.videoId, reason);
      throw new Error(reason);
    }
  } finally {
    await Promise.all(
      cleanupTargets.map((target) =>
        fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
      )
    );
  }
}

export async function transcribeStandaloneVideo(input: {
  platform: Platform;
  videoId: string;
  mediaUrl?: string;
  douyinMediaUrl?: string;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const directMediaUrl = input.mediaUrl?.trim() || input.douyinMediaUrl?.trim() || "";

  if (!directMediaUrl) {
    const pageUrl = input.platform === "bilibili"
      ? `https://www.bilibili.com/video/${encodeURIComponent(input.videoId)}`
      : buildDouyinVideoUrl(input.videoId);
    if (!pageUrl) throw new Error("远程转写缺少可用的视频链接。");
    return transcribeLinkSource({
      url: pageUrl,
      titleHint: input.videoId,
      analyzeVideo: false,
      signal: input.signal
    });
  }

  const cleanupTargets: string[] = [];
  const timings: Timing[] = [];
  const startedAt = Date.now();
  try {
    const downloaded = await downloadRemoteAudio(
      directMediaUrl,
      `${normalizeTemporaryFileName(input.videoId)}.mp3`,
      { signal: input.signal }
    );
    cleanupTargets.push(downloaded.mediaPath);
    timings.push({ stage: "download-media-url-audio", ms: downloaded.ms });

    const prepared = await prepareAudioForVolcengine(downloaded.mediaPath, { signal: input.signal });
    if (prepared.cleanupPath) cleanupTargets.push(prepared.cleanupPath);
    timings.push(...prepared.timings);

    const result = await transcribeWithVolcengine(prepared.mediaPath, { signal: input.signal });
    timings.push(...result.timings);
    const cleaned = await cleanTranscriptText({
      platform: input.platform,
      title: input.videoId,
      text: result.text,
      signal: input.signal
    });
    return {
      url: directMediaUrl,
      resolvedUrl: directMediaUrl,
      platform: input.platform,
      text: cleaned.text,
      source: "volcengine" as const,
      durationSec: result.durationSec,
      segments: result.segments,
      timings: [...timings, { stage: "total", ms: Date.now() - startedAt }],
      transcriptCleaning: {
        fallback: cleaned.fallback,
        fallbackReason: cleaned.fallbackReason,
        usedModel: cleaned.usedModel
      }
    };
  } finally {
    await Promise.all(
      [...new Set(cleanupTargets)].map((target) =>
        fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
      )
    );
  }
}

export async function transcribeLinkSource(input: {
  url: string;
  titleHint?: string;
  analyzeVideo?: boolean;
  signal?: AbortSignal;
}): Promise<LinkTranscriptionResult> {
  throwIfAborted(input.signal);
  const startedAt = Date.now();
  const resolvedUrl = await resolveShareUrl(input.url, { signal: input.signal }).catch((error) => {
    if (isAbortError(error)) throw error;
    return input.url;
  });
  const platform = detectPlatformFromLink(resolvedUrl || input.url);
  let subtitleResult: LinkTranscriptionResult | null = null;
  let bilibiliSubtitleError = "";

  if (platform === "bilibili") {
    let subtitle = "";
    try {
      subtitle = await getBilibiliSubtitle({
        id: resolvedUrl,
        url: resolvedUrl,
        raw: resolvedUrl
      } as Video, { signal: input.signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      bilibiliSubtitleError = formatErrorDetail(error);
    }
    if (subtitle.trim()) {
      const metadata = await resolveLinkStatsMetadata(resolvedUrl || input.url, platform, { signal: input.signal });
      const cleaned = await cleanTranscriptText({
        platform,
        title: input.titleHint || metadata.title,
        text: subtitle,
        signal: input.signal
      });
      subtitleResult = {
        url: input.url,
        resolvedUrl,
        platform,
        title: input.titleHint || metadata.title,
        sourceAccountName: metadata.sourceAccountName,
        coverUrl: metadata.coverUrl,
        text: cleaned.text,
        source: "platform_subtitle",
        fallback: cleaned.fallback,
        fallbackReason: cleaned.fallbackReason,
        timings: [{ stage: "total", ms: Date.now() - startedAt }]
      };
      if (!input.analyzeVideo) return subtitleResult;
    }
  }

  if (platform !== "douyin" && platform !== "bilibili") {
    throw new Error(`暂不支持从这个链接提取视频文稿：${input.url}`);
  }

  const media = await resolveLinkMediaUrl({
    url: input.url,
    resolvedUrl,
    platform,
    signal: input.signal
  });
  if (subtitleResult) {
    return {
      ...subtitleResult,
      title: media.title || subtitleResult.title,
      sourceAccountName: media.sourceAccountName || subtitleResult.sourceAccountName,
      coverUrl: media.coverUrl || subtitleResult.coverUrl,
      mediaUrls: media.mediaUrls,
      timings: [{ stage: "resolve-video-media", ms: Date.now() - startedAt }]
    };
  }
  if (!media.mediaUrls.length) {
    if (media.title) {
      const fallbackReason = buildLinkMetadataOnlyReason({
        title: media.title,
        bilibiliSubtitleError
      });
      return {
        url: input.url,
        resolvedUrl,
        platform,
        title: media.title,
        sourceAccountName: media.sourceAccountName,
        coverUrl: media.coverUrl,
        mediaUrls: [],
        text: "",
        source: "metadata",
        metadataTitle: media.title,
        fallback: true,
        fallbackReason
      };
    }
    throw new Error(buildLinkMissingMediaReason(input.url, bilibiliSubtitleError));
  }

  const cleanupTargets: string[] = [];
  try {
    throwIfAborted(input.signal);
    const downloaded = await downloadFirstAvailableRemoteAudio(
      media.mediaUrls,
      `${safeFileName(media.mediaId || "link-video")}.mp3`,
      { signal: input.signal }
    );
    cleanupTargets.push(downloaded.mediaPath);
    const preparedForAsr = await prepareAudioForVolcengine(downloaded.mediaPath, { signal: input.signal });
    if (preparedForAsr.cleanupPath) cleanupTargets.push(preparedForAsr.cleanupPath);
    const volcengine = await transcribeWithVolcengine(preparedForAsr.mediaPath, { signal: input.signal });
    throwIfAborted(input.signal);
    const cleaned = await cleanTranscriptText({
      platform,
      title: media.title || input.titleHint,
      text: volcengine.text,
      signal: input.signal
    });
    return {
      url: input.url,
      resolvedUrl,
      platform,
      title: media.title || input.titleHint,
      sourceAccountName: media.sourceAccountName,
      coverUrl: media.coverUrl,
      mediaUrls: media.mediaUrls,
      text: cleaned.text,
      source: "volcengine",
      fallback: platform === "bilibili" || cleaned.fallback,
      fallbackReason: [
        platform === "bilibili"
          ? `中文字幕不可用，已改为识别原视频音频${bilibiliSubtitleError ? `（${bilibiliSubtitleError}）` : ""}。`
          : "",
        cleaned.fallbackReason
      ].filter(Boolean).join("；") || undefined,
      durationSec: volcengine.durationSec,
      segments: volcengine.segments,
      timings: [
        { stage: "download-remote-audio", ms: downloaded.ms },
        ...(downloaded.attempts.length > 1 ? [{ stage: `media-url-attempts-${downloaded.attempts.length}`, ms: 0 }] : []),
        ...preparedForAsr.timings,
        ...volcengine.timings,
        { stage: "total", ms: Date.now() - startedAt }
      ]
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (platform === "bilibili" && bilibiliSubtitleError) {
      throw new Error(`B站字幕抓取失败：${bilibiliSubtitleError}；音频转写也失败：${formatErrorDetail(error)}`);
    }
    throw error;
  } finally {
    await Promise.all(cleanupTargets.map((target) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)));
  }
}

function normalizeTemporaryFileName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "remote-video";
}

export async function resolveLinkSourceAccountName(url: string) {
  const inputUrl = url.trim();
  if (!inputUrl) return "";
  const resolvedUrl = await resolveShareUrl(inputUrl).catch(() => inputUrl);
  const platform = detectPlatformFromLink(resolvedUrl || inputUrl);
  if (platform !== "douyin" && platform !== "bilibili") return "";
  const metadata = await resolveLinkStatsMetadata(resolvedUrl || inputUrl, platform);
  if (metadata.sourceAccountName) return metadata.sourceAccountName;
  const media = await resolveLinkSourceMedia({
    url: inputUrl,
    resolvedUrl,
    platform
  }).catch(() => null);
  return media?.sourceAccountName?.trim() || "";
}

export function isSupportedVideoSourceLink(url: string) {
  return detectPlatformFromLink(url) !== "unknown";
}

export async function resolveLinkSourceMedia(input: {
  url: string;
  resolvedUrl?: string;
  platform?: Platform | "unknown";
  signal?: AbortSignal;
}): Promise<LinkSourceResolvedMedia> {
  throwIfAborted(input.signal);
  const resolvedUrl = input.resolvedUrl || (await resolveShareUrl(input.url, { signal: input.signal }).catch((error) => {
    if (isAbortError(error)) throw error;
    return input.url;
  }));
  const platform = input.platform && input.platform !== "unknown"
    ? input.platform
    : detectPlatformFromLink(resolvedUrl || input.url);
  if (platform !== "douyin" && platform !== "bilibili") {
    return {
      url: input.url,
      resolvedUrl,
      platform,
      title: undefined,
      sourceAccountName: undefined,
      coverUrl: undefined,
      mediaUrls: []
    };
  }
  const media = await resolveLinkMediaUrl({
    url: input.url,
    resolvedUrl,
    platform,
    signal: input.signal
  });
  return {
    url: input.url,
    resolvedUrl: platform === "douyin" && media.mediaId ? buildDouyinVideoUrl(media.mediaId) : resolvedUrl,
    platform,
    title: media.title,
    sourceAccountName: media.sourceAccountName,
    coverUrl: media.coverUrl,
    mediaUrls: media.mediaUrls
  };
}

export async function prepareLinkSourceDownload(input: {
  url: string;
  kind: LinkSourceAssetKind;
}, options: AbortableOptions = {}): Promise<LinkSourceDownloadAsset> {
  throwIfAborted(options.signal);
  if (input.kind === "cover") {
    return prepareLinkSourceCoverDownload(input.url, options);
  }

  const resolvedUrl = await resolveShareUrl(input.url, { signal: options.signal }).catch((error) => {
    if (isAbortError(error)) throw error;
    return input.url;
  });
  const platform = detectPlatformFromLink(resolvedUrl || input.url);
  if (platform === "bilibili") {
    return prepareBilibiliSourceDownload(input.url, resolvedUrl, input.kind, options);
  }

  const media = await resolveLinkSourceMedia({
    url: input.url,
    resolvedUrl,
    platform,
    signal: options.signal
  });
  if (media.platform !== "bilibili" && media.platform !== "douyin") {
    throw new Error("暂不支持下载这个链接，请粘贴 B站或抖音单条视频链接。");
  }

  const baseName = makeLinkSourceFileBaseName(media);

  if (input.kind === "audio") {
    const audioUrls = media.platform === "bilibili" ? selectRemoteAudioMediaUrls(media.mediaUrls) : media.mediaUrls;
    if (!audioUrls.length) {
      throw new Error("没有解析到可提取音频的媒体地址。");
    }
    const downloaded = await downloadFirstAvailableRemoteAudio(
      audioUrls,
      `${baseName}.mp3`,
      options
    );
    return {
      kind: input.kind,
      fileName: `${baseName}.mp3`,
      contentType: "audio/mpeg",
      filePath: downloaded.mediaPath,
      cleanupTargets: [downloaded.mediaPath]
    };
  }

  if (media.platform === "bilibili") {
    throwIfAborted(options.signal);
    const downloaded = await downloadRemoteVideoAsset(media, `${baseName}.mp4`, options);
    throwIfAborted(options.signal);
    return {
      kind: input.kind,
      fileName: `${baseName}.mp4`,
      contentType: "video/mp4",
      filePath: downloaded.filePath,
      cleanupTargets: [downloaded.filePath]
    };
  }

  throwIfAborted(options.signal);
  const downloaded = await downloadRemoteVideoAsset(media, `${baseName}.mp4`, options);
  throwIfAborted(options.signal);
  return {
    kind: input.kind,
    fileName: `${baseName}.mp4`,
    contentType: "video/mp4",
    filePath: downloaded.filePath,
    cleanupTargets: [downloaded.filePath]
  };
}

async function prepareBilibiliSourceDownload(
  url: string,
  resolvedUrl: string,
  kind: Exclude<LinkSourceAssetKind, "cover">,
  options: AbortableOptions
): Promise<LinkSourceDownloadAsset> {
  throwIfAborted(options.signal);
  const pageUrl = resolvedUrl || url;
  const reference = await getBilibiliPublicVideoReference({
    id: pageUrl,
    url: pageUrl,
    raw: pageUrl,
    title: "",
    coverUrl: ""
  }, { signal: options.signal }).catch((error) => {
    if (isAbortError(error)) throw error;
    return null;
  });
  const media: LinkSourceResolvedMedia = {
    url,
    resolvedUrl,
    platform: "bilibili",
    title: reference?.title,
    coverUrl: normalizeRemoteImageUrl(reference?.thumbnail || "") || undefined,
    mediaUrls: []
  };
  const baseName = makeLinkSourceFileBaseName(media);
  const downloadedPath = await downloadBilibiliVideo({
    id: reference?.bvid || pageUrl,
    platform: "bilibili",
    accountId: "",
    title: reference?.title || "",
    url: pageUrl,
    duration: "",
    publishedAt: "",
    stats: { views: 0, likes: 0, comments: 0, favorites: 0, shares: 0 },
    hotScore: 0,
    relativeViewRate: 0,
    transcriptStatus: "not_started",
    raw: pageUrl,
    updatedAt: new Date().toISOString()
  }, { signal: options.signal });
  const cleanupRoot = getBilibiliDownloadCleanupRoot(downloadedPath);

  if (kind === "video") {
    const extension = path.extname(downloadedPath) || ".mp4";
    return {
      kind,
      fileName: `${baseName}${extension}`,
      contentType: inferRemoteContentType(downloadedPath, "video"),
      filePath: downloadedPath,
      cleanupTargets: [cleanupRoot]
    };
  }

  try {
    const extracted = await extractLocalAudio(downloadedPath, `${baseName}.mp3`, options);
    return {
      kind,
      fileName: `${baseName}.mp3`,
      contentType: "audio/mpeg",
      filePath: extracted.mediaPath,
      cleanupTargets: [cleanupRoot, extracted.mediaPath]
    };
  } catch (error) {
    await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function getBilibiliDownloadCleanupRoot(downloadedPath: string) {
  const relative = path.relative(os.tmpdir(), downloadedPath);
  const firstSegment = relative.split(path.sep)[0];
  if (!relative.startsWith("..") && firstSegment.startsWith("style-library-bilibili-")) {
    return path.join(os.tmpdir(), firstSegment);
  }
  return downloadedPath;
}

async function prepareLinkSourceCoverDownload(url: string, options: AbortableOptions): Promise<LinkSourceDownloadAsset> {
  throwIfAborted(options.signal);
  const resolvedUrl = await resolveShareUrl(url, { signal: options.signal }).catch((error) => {
    if (isAbortError(error)) throw error;
    return url;
  });
  const platform = detectPlatformFromLink(resolvedUrl || url);
  if (platform !== "bilibili" && platform !== "douyin") {
    throw new Error("暂不支持下载这个链接的封面，请粘贴 B站或抖音单条视频链接。");
  }

  let media: LinkMediaInfo;
  if (platform === "bilibili") {
    const reference = await getBilibiliPublicVideoReference({
      id: resolvedUrl || url,
      url: resolvedUrl || url,
      raw: resolvedUrl || url,
      title: "",
      coverUrl: ""
    }, { signal: options.signal });
    media = {
      mediaId: reference?.bvid,
      title: reference?.title,
      coverUrl: normalizeRemoteImageUrl(reference?.thumbnail || "") || undefined,
      mediaUrls: []
    };
  } else {
    const publicMedia = await resolveGenericLinkMedia(resolvedUrl || url, { signal: options.signal }).catch((error) => {
      if (isAbortError(error)) throw error;
      return null;
    });
    media = publicMedia?.coverUrl
      ? publicMedia
      : await resolveDouyinLinkMedia(resolvedUrl || url, { signal: options.signal });
  }

  const coverUrl = normalizeRemoteImageUrl(media.coverUrl || "");
  if (!coverUrl) {
    throw new Error("没有解析到这条视频的封面地址。");
  }
  const source: LinkSourceResolvedMedia = {
    url,
    resolvedUrl,
    platform,
    title: media.title,
    sourceAccountName: media.sourceAccountName,
    coverUrl,
    mediaUrls: []
  };
  const baseName = makeLinkSourceFileBaseName(source);
  return {
    kind: "cover",
    fileName: `${baseName}${inferRemoteFileExtension(coverUrl, "image")}`,
    contentType: inferRemoteContentType(coverUrl, "image"),
    remoteUrl: coverUrl,
    requestHeaders: buildRemoteAssetRequestHeaders(coverUrl)
  };
}

async function transcribeWithVolcengine(
  mediaPath: string,
  options: AbortableOptions = {}
): Promise<{
  text: string;
  timings: Timing[];
  durationSec?: number;
  segments: Array<{ startSec: number; endSec: number; text: string }>;
}> {
  throwIfAborted(options.signal);
  const config = transcriptionConfig();
  if (!config.apiKey && (!config.appKey || !config.accessKey)) {
    throw new Error("未配置 VOLCENGINE_ASR_API_KEY，无法调用火山引擎录音文件识别 2.0");
  }

  const timings: Timing[] = [];
  const readStartedAt = Date.now();
  const audioBytes = await fs.readFile(mediaPath);
  timings.push({ stage: "read-audio-file", ms: Date.now() - readStartedAt });
  const encodeStartedAt = Date.now();
  const audioData = audioBytes.toString("base64");
  timings.push({ stage: "encode-audio-base64", ms: Date.now() - encodeStartedAt });
  const body = {
    user: {
      uid: config.uid || config.apiKey || config.appKey || "style-library"
    },
    audio: {
      format: config.audioFormat || inferVolcengineAudioFormat(mediaPath),
      data: audioData
    },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true
    }
  };

  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= config.retryCount) {
    const taskId = randomUUID();
    const headers = buildVolcengineHeaders(config, taskId);
    const attemptPrefix = attempt > 0 ? `retry-${attempt + 1}-` : "";

    try {
      const submitStartedAt = Date.now();
      const submitResponse = await fetchWithTimeout(
        config.submitUrl,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        },
        config.timeoutMs,
        options.signal
      );
      await assertVolcengineResponse(submitResponse, "提交火山引擎转写任务", ["20000000"]);
      timings.push({ stage: `${attemptPrefix}volcengine-submit`, ms: Date.now() - submitStartedAt });

      const queryStartedAt = Date.now();
      let pollWaitMs = 0;
      let queryRequestMs = 0;
      for (let pollAttempt = 0; pollAttempt < config.maxPollAttempts; pollAttempt += 1) {
        throwIfAborted(options.signal);
        if (pollAttempt > 0) {
          const waitStartedAt = Date.now();
          await sleep(config.pollIntervalMs, options.signal);
          pollWaitMs += Date.now() - waitStartedAt;
        }
        const queryRequestStartedAt = Date.now();
        const queryResponse = await fetchWithTimeout(
          config.queryUrl,
          {
            method: "POST",
            headers,
            body: "{}"
          },
          config.timeoutMs,
          options.signal
        );
        queryRequestMs += Date.now() - queryRequestStartedAt;
        const statusCode = getVolcengineHeader(queryResponse, "X-Api-Status-Code");
        if (statusCode === "20000001" || statusCode === "20000002") continue;
        await assertVolcengineResponse(queryResponse, "查询火山引擎转写结果", ["20000000"]);
        const data = (await queryResponse.json()) as unknown;
        const text = extractVolcengineTranscript(data);
        if (!text.trim()) {
          throw new Error("火山引擎没有返回转写文本");
        }
        timings.push({ stage: `${attemptPrefix}volcengine-query-requests`, ms: queryRequestMs });
        if (pollWaitMs) timings.push({ stage: `${attemptPrefix}volcengine-poll-wait`, ms: pollWaitMs });
        timings.push({ stage: `${attemptPrefix}volcengine-query`, ms: Date.now() - queryStartedAt });
        const segments = extractVolcengineSegments(data);
        return {
          text: text.trim(),
          timings,
          durationSec: segments.length ? segments[segments.length - 1].endSec : undefined,
          segments
        };
      }

      throw new Error("火山引擎转写任务查询超时，请稍后重试。");
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      if (!shouldRetryVolcengineError(error) || attempt >= config.retryCount) {
        break;
      }
      const backoffMs = 1200 * (attempt + 1);
      timings.push({ stage: `${attemptPrefix}volcengine-retry-wait`, ms: backoffMs });
      await sleep(backoffMs, options.signal);
      attempt += 1;
    }
  }

  timings.push({ stage: "volcengine-total-attempts", ms: Date.now() - startedAt });
  throw lastError instanceof Error ? lastError : new Error("火山引擎转写失败");
}

async function prepareAudioForVolcengine(mediaPath: string, options: AbortableOptions = {}): Promise<{
  mediaPath: string;
  cleanupPath?: string;
  timings: Timing[];
}> {
  throwIfAborted(options.signal);
  if (isVolcengineSupportedAudio(mediaPath)) {
    return { mediaPath, timings: [] };
  }

  const startedAt = Date.now();
  const fileName = `${path.basename(mediaPath).replace(/[^\w.-]+/g, "-") || "media"}.mp3`;
  const converted = await extractLocalAudio(mediaPath, fileName, options);
  return {
    mediaPath: converted.mediaPath,
    cleanupPath: converted.mediaPath,
    timings: [{ stage: "prepare-local-audio", ms: Date.now() - startedAt }]
  };
}

function isVolcengineSupportedAudio(mediaPath: string) {
  return /\.mp3(\?|$)/i.test(mediaPath);
}

function buildVolcengineHeaders(
  config: ReturnType<typeof transcriptionConfig>,
  taskId: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Request-Id": taskId,
    "X-Api-Sequence": "-1"
  };
  if (config.apiKey) {
    headers["X-Api-Key"] = config.apiKey;
  } else {
    headers["X-Api-App-Key"] = config.appKey;
    headers["X-Api-Access-Key"] = config.accessKey;
  }
  return headers;
}

async function assertVolcengineResponse(response: Response, action: string, okCodes: string[]) {
  const statusCode = getVolcengineHeader(response, "X-Api-Status-Code");
  const message = getVolcengineHeader(response, "X-Api-Message");
  if (response.ok && okCodes.includes(statusCode)) return;

  const body = await response.text().catch(() => "");
  const logId = getVolcengineHeader(response, "X-Tt-Logid");
  const detail = [
    statusCode ? `状态码 ${statusCode}` : `HTTP ${response.status}`,
    message || "",
    logId ? `logid ${logId}` : "",
    body ? body.slice(0, 500) : ""
  ]
    .filter(Boolean)
    .join("，");
  throw new Error(`${action}失败：${detail || "未知错误"}`);
}

function getVolcengineHeader(response: Response, name: string) {
  return response.headers.get(name) || response.headers.get(name.toLowerCase()) || "";
}

function extractVolcengineTranscript(data: unknown): string {
  const object = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const result = object.result;
  const directText = readTextField(result) || readTextField(object);
  if (directText) return directText;

  const utteranceText = extractUtteranceText(result) || extractUtteranceText(object);
  if (utteranceText) return utteranceText;

  if (Array.isArray(result)) {
    const pieces = result
      .map((item) => readTextField(item) || extractUtteranceText(item))
      .filter(Boolean);
    if (pieces.length) return pieces.join("\n");
  }

  return "";
}

function extractVolcengineSegments(data: unknown) {
  const object = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const candidates = [object.result, object];
  if (Array.isArray(object.result)) candidates.push(...object.result);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const utterances = (candidate as Record<string, unknown>).utterances;
    if (!Array.isArray(utterances)) continue;
    const segments = utterances
      .map((item) => normalizeVolcengineSegment(item))
      .filter((item): item is { startSec: number; endSec: number; text: string } => Boolean(item));
    if (segments.length) return segments;
  }
  return [];
}

function normalizeVolcengineSegment(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const text = readTextField(object);
  if (!text) return null;
  const startSec = readSegmentTime(object, ["start_time", "startTime", "start_ms", "startMs"], ["start"]);
  const endSec = readSegmentTime(object, ["end_time", "endTime", "end_ms", "endMs"], ["end"]);
  if (startSec === null || endSec === null || endSec < startSec) return null;
  return { startSec, endSec, text };
}

function readSegmentTime(
  object: Record<string, unknown>,
  millisecondKeys: string[],
  secondKeys: string[]
) {
  for (const key of millisecondKeys) {
    const value = Number(object[key]);
    if (Number.isFinite(value) && value >= 0) return value / 1000;
  }
  for (const key of secondKeys) {
    const value = Number(object[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function readTextField(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text.trim() : "";
}

function extractUtteranceText(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const utterances = (value as Record<string, unknown>).utterances;
  if (!Array.isArray(utterances)) return "";
  return utterances
    .map((item) => readTextField(item))
    .filter(Boolean)
    .join("\n");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(signal);
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`火山引擎请求超时：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function shouldRetryVolcengineError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR|超时|timeout|503|502|504|socket/i.test(message);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /aborted|任务已停止/i.test(error.message));
}

function ignoreNonAbortError(error: unknown) {
  if (isAbortError(error)) throw error;
}

function createAbortError() {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}

function formatErrorDetail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.replace(/\s+/g, " ").trim();
}

async function resolveShareUrl(url: string, options: AbortableOptions = {}) {
  throwIfAborted(options.signal);
  // Full Douyin work links already identify the target; avoid a redundant page GET.
  if (detectPlatformFromLink(url) === "douyin" && extractDouyinAwemeId(url)) {
    return buildDouyinVideoUrl(extractDouyinAwemeId(url));
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(options.signal);
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": browserUserAgent()
      }
    });
    return response.url || url;
  } catch {
    if (options.signal?.aborted) throw createAbortError();
    return url;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }
}

async function resolveLinkMediaUrl(input: {
  url: string;
  resolvedUrl: string;
  platform: Platform;
  signal?: AbortSignal;
}): Promise<LinkMediaInfo> {
  throwIfAborted(input.signal);
  if (input.platform === "douyin") {
    return resolveDouyinLinkMedia(input.resolvedUrl || input.url, { signal: input.signal });
  }

  if (input.platform === "bilibili") {
    const media = await resolveBilibiliLinkMedia(input.resolvedUrl || input.url, { signal: input.signal });
    return hydrateLinkMediaInfo(media, input.resolvedUrl || input.url, input.platform, { signal: input.signal });
  }

  return resolveGenericLinkMedia(input.resolvedUrl || input.url, { signal: input.signal });
}

async function hydrateLinkMediaInfo(
  media: LinkMediaInfo,
  url: string,
  platform: Platform,
  options: AbortableOptions = {}
): Promise<LinkMediaInfo> {
  if (media.title && media.sourceAccountName && media.coverUrl) {
    return { ...media, coverUrl: normalizeRemoteImageUrl(media.coverUrl) };
  }
  throwIfAborted(options.signal);
  const metadata = await resolveLinkStatsMetadata(url, platform, { signal: options.signal });
  throwIfAborted(options.signal);
  return {
    ...media,
    title: media.title || metadata.title,
    sourceAccountName: media.sourceAccountName || metadata.sourceAccountName,
    coverUrl: normalizeRemoteImageUrl(media.coverUrl || metadata.coverUrl || "") || undefined
  };
}

async function resolveLinkStatsMetadata(
  url: string,
  platform: Platform,
  options: AbortableOptions = {}
): Promise<Pick<LinkMediaInfo, "title" | "sourceAccountName" | "coverUrl">> {
  if (!url.trim()) return {};
  throwIfAborted(options.signal);
  if (platform === "bilibili") {
    const stats = await getBilibiliVideoStatsByUrl(url, { signal: options.signal }).catch((error) => {
      if (isAbortError(error)) throw error;
      return null;
    });
    const reference = await getBilibiliVideoReference({
      id: url,
      url,
      raw: url,
      title: stats?.title || "",
      coverUrl: ""
    }, { signal: options.signal }).catch((error) => {
      if (isAbortError(error)) throw error;
      return null;
    });
    return {
      title: stats?.title?.trim() || undefined,
      sourceAccountName: stats?.authorName?.trim() || undefined,
      coverUrl: normalizeRemoteImageUrl(reference?.thumbnail || "") || undefined
    };
  }
  if (platform === "douyin") {
    const stats = await getDouyinVideoStatsByUrl(url, { signal: options.signal }).catch((error) => {
      if (isAbortError(error)) throw error;
      return null;
    });
    return {
      title: stats?.title?.trim() || undefined,
      sourceAccountName: stats?.authorName?.trim() || undefined,
      coverUrl: undefined
    };
  }
  return {};
}

async function resolveBilibiliLinkMedia(url: string, options: AbortableOptions = {}) {
  return withSharedOpenCliBrowserSession(async (workspace) => {
    try {
      throwIfAborted(options.signal);
      const openArgs = buildOpenCliBrowserArgs(workspace, "open", [url], {
        window: "background"
      });
      await runOpenCli(openArgs, {
        timeout: 30_000,
        signal: options.signal
      });
      await runOpenCli(buildOpenCliBrowserArgs(workspace, "wait", ["time", "3"]), {
        timeout: 12_000,
        signal: options.signal
      }).catch(ignoreNonAbortError);
      const stdout = await runOpenCli(buildOpenCliBrowserArgs(workspace, "eval", [BILIBILI_LINK_MEDIA_EXTRACT_JS]), {
        timeout: 30_000,
        signal: options.signal
      });
      const data = parseOpenCliJsonish(stdout);
      const object = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
      const mediaUrls = Array.isArray(object.mediaUrls) ? object.mediaUrls.map((value) => String(value || "")) : [];
      return {
        mediaId: String(object.bvid || extractBvid(url) || ""),
        title: normalizeTitle(String(object.title || object.description || "")),
        sourceAccountName: normalizeTitle(String(object.sourceAccountName || "")),
        coverUrl: normalizeRemoteImageUrl(String(object.coverUrl || "")),
        mediaUrls: sortRemoteAudioMediaUrls(mediaUrls)
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw formatLinkBrowserResolutionError("B站", error);
    }
  }, { signal: options.signal });
}

async function resolveDouyinLinkMedia(url: string, options: AbortableOptions = {}): Promise<LinkMediaInfo> {
  const reference = await getDouyinSingleVideoReference(url, options);
  return {
    mediaId: reference.id,
    title: normalizeTitle(reference.title),
    sourceAccountName: normalizeTitle(reference.authorName),
    coverUrl: reference.coverUrl,
    mediaUrls: [reference.mediaUrl]
  };
}

function formatLinkBrowserResolutionError(platformLabel: "B站" | "抖音", error: unknown) {
  const detail = formatErrorDetail(error);
  if (/opencli browser|not connected|extension|browser profile/i.test(detail)) {
    return new Error(`${platformLabel}素材解析需要 OpenCLI 浏览器扩展，当前扩展未连接。请连接扩展后重试。`);
  }
  return new Error(`${platformLabel}素材解析失败：${detail}`);
}

async function resolveGenericLinkMedia(url: string, options: AbortableOptions = {}) {
  throwIfAborted(options.signal);
  const response = await fetch(url, {
    redirect: "follow",
    signal: options.signal,
    headers: {
      "User-Agent": browserUserAgent()
    }
  });
  const html = await response.text().catch(() => "");
  const mediaUrls = [
    ...Array.from(html.matchAll(/https?:\\?\/\\?\/[^"'<>\\]+?(?:\.mp4|\.m4a|\.mp3|mime_type=(?:video|audio)_[^"'<>\\]+)/gi)).map((match) =>
      match[0].replaceAll("\\/", "/")
    )
  ];
  return {
    mediaId: response.url,
    title: normalizeTitle(extractHtmlTitle(html)),
    sourceAccountName: "",
    coverUrl: normalizeRemoteImageUrl(extractHtmlImage(html)),
    mediaUrls: sortRemoteAudioMediaUrls(mediaUrls)
  };
}

async function downloadFirstAvailableRemoteAudio(
  urls: string[],
  fileName: string,
  options: AbortableOptions = {}
) {
  const attempts: Array<{ url: string; error?: string; ms?: number }> = [];
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  let lastError: unknown;

  for (const [index, url] of uniqueUrls.entries()) {
    try {
      throwIfAborted(options.signal);
      const downloaded = await downloadRemoteAudio(url, `${index + 1}-${fileName}`, options);
      attempts.push({ url, ms: downloaded.ms });
      return { ...downloaded, attempts };
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
      attempts.push({ url, error: error instanceof Error ? error.message : "音频提取失败" });
    }
  }

  const noAudioCount = attempts.filter((attempt) => /matches no streams|stream map 'a:0'|does not contain any stream/i.test(attempt.error || "")).length;
  const detail = attempts
    .map((attempt, index) => `候选 ${index + 1}：${attempt.error || "未返回音频"}`)
    .join("；");
  if (noAudioCount === attempts.length && attempts.length > 0) {
    throw new Error(`音频提取失败：已尝试 ${attempts.length} 个媒体地址，均未包含可转写音轨。${detail}`);
  }

  throw lastError instanceof Error ? lastError : new Error("音频提取失败：没有可用媒体地址");
}

const BILIBILI_LINK_MEDIA_EXTRACT_JS = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const normalizeUrl = (url) => {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    return url;
  };
  const trimCandidateUrl = (url) => (String(url || "").split(/[\\s|<>]/)[0] || "").replace(/,https?:\\/\\/.+$/i, "");
  const isCandidate = (url) => {
    try {
      const parsed = new URL(normalizeUrl(trimCandidateUrl(url)));
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();
      if (host === "data.bilibili.com" || path.includes("/log/")) return false;
      return (
        mimeType.startsWith("audio_") ||
        mimeType.startsWith("video_") ||
        /bilivideo|akamaized/i.test(host) ||
        /\\/upgcxcode\\/|\\.m4s$|\\.mp4$|\\.m4a$|\\.mp3$/i.test(path)
      );
    } catch {
      return false;
    }
  };
  const collect = () => {
    const urls = [];
    let sourceAccountName = "";
    const pushUrl = (value) => {
      const normalized = normalizeUrl(trimCandidateUrl(String(value || "").replaceAll("\\\\/", "/")));
      if (/^https?:\\/\\//i.test(normalized) && isCandidate(normalized)) urls.push(normalized);
    };
    const collectUrlsDeep = (value, depth = 0) => {
      if (!value || depth > 8) return;
      if (typeof value === "string") {
        if (/^https?:|^\\/\\//i.test(value) && isCandidate(value)) pushUrl(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 240)) collectUrlsDeep(item, depth + 1);
        return;
      }
      if (typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (/url|base|audio|video|dash|backup|segment/i.test(key)) collectUrlsDeep(item, depth + 1);
        }
      }
    };
    const collectOwnerDeep = (value, depth = 0) => {
      if (!value || sourceAccountName || depth > 8) return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 200)) collectOwnerDeep(item, depth + 1);
        return;
      }
      if (typeof value !== "object") return;
      const object = value;
      if (object.owner && typeof object.owner === "object") {
        const name = clean(object.owner.name || object.owner.uname || object.owner.nickname);
        if (name) {
          sourceAccountName = name;
          return;
        }
      }
      const name = clean(object.uname || object.author || object.owner_name);
      if (name && (object.mid || object.uid || object.owner_mid)) {
        sourceAccountName = name;
        return;
      }
      for (const [key, item] of Object.entries(object)) {
        if (/owner|author|user|account|video|data|state/i.test(key)) collectOwnerDeep(item, depth + 1);
        if (sourceAccountName) return;
      }
    };
    for (const video of Array.from(document.querySelectorAll("video"))) {
      for (const value of [video.currentSrc, video.src]) {
        if (value) pushUrl(value);
      }
      for (const source of Array.from(video.querySelectorAll("source"))) {
        const value = source.src || source.getAttribute("src") || "";
        if (value) pushUrl(value);
      }
    }
    for (const entry of performance.getEntriesByType("resource")) {
      pushUrl(entry.name || "");
    }
    const stateValues = [
      window.__playinfo__,
      window.__INITIAL_STATE__,
      window.__INITIAL_DATA__,
      window.__NEXT_DATA__
    ];
    for (const value of stateValues) collectUrlsDeep(value);
    for (const value of stateValues) collectOwnerDeep(value);
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const text = script.textContent || "";
      if (!/playinfo|dash|baseUrl|backupUrl|upgcxcode|bilivideo/.test(text)) continue;
      const matches = text.match(/https?:\\\\?\\/\\\\?\\/[^\\s"'<>\\\\|]+/g) || [];
      for (const match of matches) pushUrl(match);
      const jsonMatch = text.match(/\\{[\\s\\S]*\\}/);
      if (jsonMatch && jsonMatch[0].length < 10_000_000) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          collectUrlsDeep(parsed);
          collectOwnerDeep(parsed);
        } catch {}
      }
    }
    const metas = Object.fromEntries(
      Array.from(document.querySelectorAll("meta[property], meta[name]"))
        .map((meta) => [meta.getAttribute("property") || meta.getAttribute("name") || "", meta.getAttribute("content") || ""])
        .filter(([key, value]) => key && value)
    );
    const metaAccountName = clean(
      metas.author ||
      metas["article:author"] ||
      metas["og:author"] ||
      document.querySelector('[itemprop="author"] [itemprop="name"], [itemprop="author"], [class*="up-name"], [class*="author"]')?.textContent ||
      ""
    );
    const coverUrl = normalizeUrl(
      metas["og:image"] ||
      metas["twitter:image"] ||
      document.querySelector("video")?.poster ||
      ""
    );
    const bvid = (location.href.match(/BV[0-9A-Za-z]+/) || [])[0] || "";
    return {
      bvid,
      title: clean(metas["og:title"] || document.title || ""),
      sourceAccountName: sourceAccountName || metaAccountName,
      coverUrl,
      description: clean(metas.description || metas["og:description"] || ""),
      mediaUrls: Array.from(new Set(urls)).filter((value) => /^https?:\\/\\//i.test(value))
    };
  };
  for (let i = 0; i < 8; i += 1) {
    const data = collect();
    if (data.mediaUrls.length) return data;
    const video = document.querySelector("video");
    if (video) video.play().catch(() => undefined);
    await sleep(1000);
  }
  return collect();
})()
`;

function extractHtmlTitle(html: string) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  return ogTitle || title || "";
}

function extractHtmlImage(html: string) {
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const twitterImage = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return ogImage || twitterImage || "";
}

function normalizeTitle(input: string) {
  return input
    .replace(/\s*-\s*抖音$/i, "")
    .replace(/\s*_\s*哔哩哔哩.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFileName(input: string) {
  return input.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "video";
}

function makeLinkSourceFileBaseName(media: LinkSourceResolvedMedia) {
  const title = media.title || media.sourceAccountName || media.resolvedUrl || media.url || "single-video";
  return safeFileName(normalizeTitle(title)).slice(0, 64) || "single-video";
}

function normalizeVolcengineAudioFormat(value: string | undefined) {
  if (!value) return "";
  const normalized = value.trim().toLowerCase();
  return ["raw", "wav", "mp3", "ogg"].includes(normalized) ? normalized : "";
}

function inferVolcengineAudioFormat(mediaPathOrUrl: string) {
  try {
    const parsed = new URL(mediaPathOrUrl);
    const mimeType = (parsed.searchParams.get("mime_type") || "").toLowerCase();
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg") || mimeType.includes("opus")) return "ogg";
    if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3";
    if (/\.(wav)(\?|$)/i.test(parsed.pathname)) return "wav";
    if (/\.(ogg|opus)(\?|$)/i.test(parsed.pathname)) return "ogg";
    if (/\.(mp3)(\?|$)/i.test(parsed.pathname)) return "mp3";
  } catch {
    if (/\.(wav)(\?|$)/i.test(mediaPathOrUrl)) return "wav";
    if (/\.(ogg|opus)(\?|$)/i.test(mediaPathOrUrl)) return "ogg";
    if (/\.(mp3)(\?|$)/i.test(mediaPathOrUrl)) return "mp3";
  }
  return "mp3";
}

async function downloadDouyinAudio(
  account: Account,
  video: Video,
  prefetchedMediaUrl?: string,
  options: AbortableOptions = {}
) {
  const mediaUrlStartedAt = Date.now();
  const mediaUrl =
    prefetchedMediaUrl ||
    video.downloadUrl ||
    (await refreshDouyinVideoDownloadUrl(account, video, { signal: options.signal }));
  const mediaUrlMs = Date.now() - mediaUrlStartedAt;
  if (!mediaUrl) {
    throw new Error("没有取得当前抖音视频的可转写媒体地址。请确认 opencli 已登录抖音、视频链接仍可访问，或重新采集账号后再试。");
  }

  const timings = [
    {
      stage: prefetchedMediaUrl ? "douyin-media-url-prefetched" : video.downloadUrl ? "douyin-media-url-cached" : "douyin-opencli",
      ms: mediaUrlMs
    }
  ];
  let extracted: { mediaPath: string; ms: number };
  try {
    throwIfAborted(options.signal);
    extracted = await downloadRemoteAudio(mediaUrl, `${video.id}.mp3`, options);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!isNoAudioStreamError(error) && (prefetchedMediaUrl || !video.downloadUrl)) throw error;

    throwIfAborted(options.signal);
    const fallbackStartedAt = Date.now();
    const fallbackUrl = await refreshDouyinVideoDownloadUrl(account, video, {
      preferBrowser: !video.downloadUrl,
      excludeUrls: [mediaUrl],
      signal: options.signal
    });
    timings.push({ stage: "douyin-media-url-audio-fallback", ms: Date.now() - fallbackStartedAt });
    if (!fallbackUrl || fallbackUrl === mediaUrl) throw error;
    try {
      throwIfAborted(options.signal);
      extracted = await downloadRemoteAudio(fallbackUrl, `${video.id}.mp3`, options);
    } catch (fallbackError) {
      if (isAbortError(fallbackError)) throw fallbackError;
      if (!isNoAudioStreamError(fallbackError)) throw fallbackError;
      throwIfAborted(options.signal);
      const browserStartedAt = Date.now();
      const browserUrl = await refreshDouyinVideoDownloadUrl(account, video, {
        preferBrowser: true,
        excludeUrls: [mediaUrl, fallbackUrl],
        signal: options.signal
      });
      timings.push({ stage: "douyin-media-url-browser-fallback", ms: Date.now() - browserStartedAt });
      if (!browserUrl || browserUrl === mediaUrl || browserUrl === fallbackUrl) throw fallbackError;
      extracted = await downloadRemoteAudio(browserUrl, `${video.id}.mp3`, options);
    }
  }

  return {
    mediaPath: extracted.mediaPath,
    timings: [
      ...timings,
      { stage: "douyin-ffmpeg-audio", ms: extracted.ms }
    ]
  };
}

async function downloadBilibiliAudio(video: Video, options: AbortableOptions = {}) {
  const mediaUrlStartedAt = Date.now();
  const pageUrl = video.url || (extractBvid(video.id) ? `https://www.bilibili.com/video/${extractBvid(video.id)}` : "");
  if (!pageUrl) {
    throw new Error("无法解析 B站视频链接，不能提取远程音频");
  }

  const media = await resolveBilibiliLinkMedia(pageUrl, { signal: options.signal });
  const timings: Timing[] = [{ stage: "bilibili-browser-media-url", ms: Date.now() - mediaUrlStartedAt }];
  if (!media.mediaUrls.length) {
    throw new Error("没有解析到可转写的 B站媒体地址");
  }

  const downloaded = await downloadFirstAvailableRemoteAudio(
    media.mediaUrls,
    `${safeFileName(media.mediaId || video.id || "bilibili-video")}.mp3`,
    options
  );

  return {
    mediaPath: downloaded.mediaPath,
    cleanupTargets: [downloaded.mediaPath],
    timings: [
      ...timings,
      { stage: "bilibili-ffmpeg-audio", ms: downloaded.ms },
      ...(downloaded.attempts.length > 1 ? [{ stage: `bilibili-media-url-attempts-${downloaded.attempts.length}`, ms: 0 }] : [])
    ]
  };
}

async function downloadRemoteVideoAsset(
  media: LinkSourceResolvedMedia,
  fileName: string,
  options: AbortableOptions = {}
) {
  const platformLabel = media.platform === "bilibili" ? "B站" : media.platform === "douyin" ? "抖音" : "远程";
  const videoUrls = selectRemoteVideoMediaUrls(media.mediaUrls).slice(0, 4);
  const audioUrls = selectRemoteAudioMediaUrls(media.mediaUrls).slice(0, 4);
  if (!videoUrls.length) {
    throw new Error(`没有解析到可下载的${platformLabel}视频流。`);
  }

  const attempts: string[] = [];
  if (audioUrls.length) {
    for (const videoUrl of videoUrls) {
      for (const audioUrl of audioUrls) {
        try {
          throwIfAborted(options.signal);
          return await mergeRemoteVideoAndAudio(videoUrl, audioUrl, fileName, options);
        } catch (error) {
          if (isAbortError(error)) throw error;
          attempts.push(formatMediaAttemptError("视频音频合并", error));
        }
      }
    }
    throw new Error(`${platformLabel}视频直连合并失败：${formatMediaAttempts(attempts)}`);
  }

  for (const videoUrl of videoUrls) {
    try {
      throwIfAborted(options.signal);
      return await downloadRemoteMuxedVideo(videoUrl, fileName, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      attempts.push(formatMediaAttemptError("视频流下载", error));
    }
  }
  throw new Error(`${platformLabel}视频直连下载失败：${formatMediaAttempts(attempts)}`);
}

async function mergeRemoteVideoAndAudio(
  videoUrl: string,
  audioUrl: string,
  fileName: string,
  options: AbortableOptions = {}
) {
  const target = path.join(os.tmpdir(), `style-library-${Date.now()}-${fileName}`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-rw_timeout",
    "15000000",
    ...buildFfmpegHeaderArgs(videoUrl),
    "-i",
    videoUrl,
    ...buildFfmpegHeaderArgs(audioUrl),
    "-i",
    audioUrl,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    target
  ];
  return runFfmpegDownload(args, target, options);
}

async function downloadRemoteMuxedVideo(url: string, fileName: string, options: AbortableOptions = {}) {
  const target = path.join(os.tmpdir(), `style-library-${Date.now()}-${fileName}`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-rw_timeout",
    "15000000",
    ...buildFfmpegHeaderArgs(url),
    "-i",
    url,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    target
  ];
  return runFfmpegDownload(args, target, options);
}

async function runFfmpegDownload(args: string[], target: string, options: AbortableOptions = {}) {
  try {
    throwIfAborted(options.signal);
    const startedAt = Date.now();
    await execFileAsync(ffmpegBin(), args, {
      ...HIDDEN_CHILD_PROCESS_OPTIONS,
      maxBuffer: 1024 * 1024 * 8,
      timeout: 20 * 60 * 1000,
      signal: options.signal
    });
    return { filePath: target, ms: Date.now() - startedAt };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    if (isAbortError(error)) throw error;
    throw new Error(describeFfmpegError(error));
  }
}

function selectRemoteVideoMediaUrls(urls: string[]) {
  return [...new Set(urls.filter(Boolean))]
    .filter((url) => !isLikelyAudioMediaUrl(url))
    .filter((url) => videoMediaUrlScore(url) > 0)
    .sort((a, b) => videoMediaUrlScore(b) - videoMediaUrlScore(a));
}

function selectRemoteAudioMediaUrls(urls: string[]) {
  return sortRemoteAudioMediaUrls(urls).filter((url) => isLikelyAudioMediaUrl(url));
}

function formatMediaAttemptError(stage: string, error: unknown) {
  return `${stage}：${formatErrorDetail(error)}`;
}

function formatMediaAttempts(attempts: string[]) {
  return attempts.length ? attempts.slice(0, 6).join("；") : "没有可用候选流。";
}

async function downloadRemoteAudio(url: string, fileName: string, options: AbortableOptions = {}) {
  throwIfAborted(options.signal);
  const target = path.join(os.tmpdir(), `style-library-${randomUUID()}-${normalizeTemporaryFileName(fileName)}`);
  const downloaded = `${target}.media`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    downloaded,
    "-vn",
    "-map",
    "a:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    target
  ];

  try {
    throwIfAborted(options.signal);
    const startedAt = Date.now();
    await downloadPublicHttpMedia(url, downloaded, { signal: options.signal, headers: buildRemoteAssetRequestHeaders(url) });
    await execFileAsync(ffmpegBin(), args, {
      ...HIDDEN_CHILD_PROCESS_OPTIONS,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 10 * 60 * 1000,
      signal: options.signal
    });
    return { mediaPath: target, ms: Date.now() - startedAt };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    if (isAbortError(error)) throw error;
    throw new Error(`音频提取失败：${describeFfmpegError(error)}`);
  } finally {
    await fs.rm(downloaded, { force: true }).catch(() => undefined);
  }
}

async function extractLocalAudio(mediaPath: string, fileName: string, options: AbortableOptions = {}) {
  const target = path.join(os.tmpdir(), `style-library-${Date.now()}-${fileName}`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    mediaPath,
    "-vn",
    "-map",
    "a:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    target
  ];

  try {
    throwIfAborted(options.signal);
    const startedAt = Date.now();
    await execFileAsync(ffmpegBin(), args, {
      ...HIDDEN_CHILD_PROCESS_OPTIONS,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 10 * 60 * 1000,
      signal: options.signal
    });
    return { mediaPath: target, ms: Date.now() - startedAt };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    if (isAbortError(error)) throw error;
    throw new Error(`音频提取失败：${describeFfmpegError(error)}`);
  }
}

function ffmpegBin() {
  return process.env.FFMPEG_BIN || "ffmpeg";
}

function isNoAudioStreamError(error: unknown) {
  return error instanceof Error && /matches no streams|stream map 'a:0'|does not contain any stream/i.test(error.message);
}

function buildFfmpegHeaderArgs(url: string) {
  if (/bilibili|bilivideo|akamaized|upgcxcode/i.test(url)) {
    return [
      "-headers",
      [
        "Accept: */*",
        "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
        "Origin: https://www.bilibili.com",
        "Referer: https://www.bilibili.com/",
        "Sec-Fetch-Dest: video",
        "Sec-Fetch-Mode: no-cors",
        "Sec-Fetch-Site: cross-site",
        `User-Agent: ${browserUserAgent()}`,
        ""
      ].join("\r\n")
    ];
  }

  if (!/douyinvod\.com/i.test(url)) return [];

  return [
    "-headers",
    [
      "Accept: */*",
      "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
      "Origin: https://www.douyin.com",
      "Referer: https://www.douyin.com/",
      "Sec-Fetch-Dest: video",
      "Sec-Fetch-Mode: no-cors",
      "Sec-Fetch-Site: cross-site",
      "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      ""
    ].join("\r\n")
  ];
}

function describeFfmpegError(error: unknown) {
  if (!(error instanceof Error)) return "ffmpeg 执行失败";
  const detail =
    "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
  if (/ENOENT/.test(error.message)) {
    return "未找到 ffmpeg，请先安装 ffmpeg，或设置 FFMPEG_BIN 指向可执行文件。";
  }
  return detail || error.message || "ffmpeg 执行失败";
}

function buildMissingMediaReason(input: {
  platform: Platform;
  mediaError: string;
  hadBilibiliSubtitle: boolean;
  bilibiliSubtitleError?: string;
}) {
  if (input.platform === "bilibili" && input.bilibiliSubtitleError) {
    if (input.mediaError) {
      return `B站字幕抓取失败：${input.bilibiliSubtitleError}。已改走远程媒体音频提取和火山转写，但音频提取失败：${input.mediaError}`;
    }
    return `B站字幕抓取失败：${input.bilibiliSubtitleError}，也没有解析到可转写的远程媒体音频地址。请检查 opencli、网络或登录状态。`;
  }

  if (input.platform === "bilibili" && !input.hadBilibiliSubtitle) {
    if (input.mediaError) {
      return `此 B站视频的公开字幕接口没有返回外挂或智能字幕轨，已改走远程媒体音频提取和火山转写，但音频提取失败：${input.mediaError}`;
    }
    return "此 B站视频的公开字幕接口没有返回外挂或智能字幕轨，也没有解析到可转写的远程媒体音频地址。";
  }

  if (input.mediaError) {
    return `没有取得可转写的媒体地址或本地文件：${input.mediaError}`;
  }

  return "没有平台字幕，也没有取得可转写的媒体地址或本地文件。";
}

function buildLinkMissingMediaReason(url: string, bilibiliSubtitleError?: string) {
  if (bilibiliSubtitleError) {
    return `B站字幕抓取失败：${bilibiliSubtitleError}，且没有解析到可转写的媒体地址：${url}`;
  }
  return `没有解析到可转写的媒体地址：${url}`;
}

function buildLinkMetadataOnlyReason(input: { title: string; bilibiliSubtitleError?: string }) {
  const titleNote = `仅解析到视频标题「${input.title}」，没有取得可用视频文稿。`;
  if (input.bilibiliSubtitleError) {
    return `${titleNote}B站字幕抓取失败：${input.bilibiliSubtitleError}，且没有解析到可转写的媒体地址。`;
  }
  return `${titleNote}没有解析到可转写的媒体地址。`;
}

function buildProviderErrorReason(platform: Platform, error: unknown, bilibiliSubtitleError?: string) {
  const message = error instanceof Error ? error.message : "转写失败";
  if (platform === "bilibili" && bilibiliSubtitleError) {
    return `B站字幕抓取失败：${bilibiliSubtitleError}；音频转写也失败：${message}`;
  }
  if (platform === "bilibili" && message.includes("VOLCENGINE_ASR_API_KEY")) {
    return "此 B站视频没有发现外挂或智能字幕，已回退到火山转写，但当前未配置 VOLCENGINE_ASR_API_KEY。";
  }
  return message;
}
