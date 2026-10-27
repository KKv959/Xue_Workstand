import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { analyzeMaterialFrames } from "./ai";
import { browserUserAgent } from "./platform-links";
import type { CopySource, Platform } from "./types";

const execFileAsync = promisify(execFile);
const HIDDEN_CHILD_PROCESS_OPTIONS = { windowsHide: true };
const FRAME_EXTRACTION_TIMEOUT_MS = 25_000;
const FRAME_EXTRACTION_URL_LIMIT = 2;
const MATERIAL_MODEL_TIMEOUT_MS = 45_000;

export async function analyzeCopySourceMaterial(input: {
  mediaUrls: string[];
  platform: Platform | "unknown";
  title?: string;
  transcript: string;
  url: string;
  signal?: AbortSignal;
}): Promise<CopySource["materialAnalysis"]> {
  throwIfAborted(input.signal);
  if (!input.mediaUrls.length) {
    return {
      mode: "textual",
      status: "skipped",
      summary: buildTextualSummary(input),
      fallbackReason: "没有取得可抽帧的原视频地址，仅保存标题和转写。",
      generatedAt: new Date().toISOString()
    };
  }

  let frames: string[] = [];
  let frameError = "";
  try {
    frames = await extractVideoFrames(input.mediaUrls, { signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    frameError = error instanceof Error ? error.message : "原视频抽帧失败";
  }

  if (!frames.length) {
    return {
      mode: "textual",
      status: "skipped",
      summary: buildTextualSummary(input),
      fallbackReason: frameError || "没有取得可分析的视频画面，仅保存标题和转写。",
      generatedAt: new Date().toISOString()
    };
  }

  try {
    const analysis = await withAbortTimeout(
      (signal) =>
        analyzeMaterialFrames({
          frames,
          platform: input.platform,
          title: input.title,
          transcript: input.transcript,
          url: input.url,
          signal
        }),
      MATERIAL_MODEL_TIMEOUT_MS,
      input.signal
    );
    return {
      mode: "multimodal",
      status: "completed",
      frameCount: frames.length,
      generatedAt: new Date().toISOString(),
      ...analysis
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      mode: "multimodal",
      status: "failed",
      frameCount: frames.length,
      summary: buildTextualSummary(input),
      error: error instanceof Error ? error.message : "原视频画面描述失败",
      fallbackReason: "已抽到视频帧，但模型未返回可用画面描述。风格卡会继续使用标题和转写。",
      generatedAt: new Date().toISOString()
    };
  }
}

async function extractVideoFrames(urls: string[], options: { signal?: AbortSignal } = {}) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))].slice(0, FRAME_EXTRACTION_URL_LIMIT);
  let lastError: unknown;

  for (const [index, url] of uniqueUrls.entries()) {
    const dir = path.join(os.tmpdir(), `style-library-frames-${process.pid}-${Date.now()}-${index}`);
    try {
      throwIfAborted(options.signal);
      await fs.mkdir(dir, { recursive: true });
      const output = path.join(dir, "frame-%02d.jpg");
      await execFileAsync(ffmpegBin(), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-rw_timeout",
        "8000000",
        ...buildFfmpegHeaderArgs(url),
        "-i",
        url,
        "-an",
        "-sn",
        "-dn",
        "-t",
        "16",
        "-vf",
        "fps=1/4,scale='min(960,iw)':-2",
        "-frames:v",
        "4",
        "-q:v",
        "3",
        output
      ], {
        ...HIDDEN_CHILD_PROCESS_OPTIONS,
        maxBuffer: 1024 * 1024 * 4,
        timeout: FRAME_EXTRACTION_TIMEOUT_MS,
        killSignal: "SIGKILL",
        signal: options.signal
      });
      throwIfAborted(options.signal);
      const files = (await fs.readdir(dir)).filter((file) => /\.jpg$/i.test(file)).sort().slice(0, 4);
      const frames = await Promise.all(
        files.map(async (file) => {
          const bytes = await fs.readFile(path.join(dir, file));
          return `data:image/jpeg;base64,${bytes.toString("base64")}`;
        })
      );
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (frames.length) return frames;
    } catch (error) {
      if (options.signal?.aborted) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      lastError = error;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  throw new Error(describeFfmpegError(lastError));
}

async function withAbortTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    parentSignal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("任务已停止");
  error.name = "AbortError";
  throw error;
}

function buildTextualSummary(input: { title?: string; transcript: string }) {
  const title = input.title?.trim();
  const transcript = input.transcript.trim();
  if (title && transcript && title !== transcript) {
    return `标题线索：${title}\n转写线索：${transcript.slice(0, 500)}`;
  }
  return title || transcript.slice(0, 600) || "没有可用素材线索。";
}

function ffmpegBin() {
  return process.env.FFMPEG_BIN || "ffmpeg";
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
      `User-Agent: ${browserUserAgent()}`,
      ""
    ].join("\r\n")
  ];
}

function describeFfmpegError(error: unknown) {
  if (!(error instanceof Error)) return "原视频抽帧失败";
  const detail =
    "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
  if (/ENOENT/.test(error.message)) {
    return "未找到 ffmpeg，请先安装 ffmpeg，或设置 FFMPEG_BIN 指向可执行文件。";
  }
  if (/SIGKILL|ETIMEDOUT|timed out|timeout|killed/i.test(`${error.message} ${detail}`)) {
    return "原视频抽帧超时，已降级为标题和转写。";
  }
  return detail || error.message || "原视频抽帧失败";
}
