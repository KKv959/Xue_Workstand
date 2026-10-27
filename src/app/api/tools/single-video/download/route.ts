import { createReadStream } from "fs";
import { promises as fs } from "fs";
import { Readable } from "stream";
import { z } from "zod";
import { apiError, parseJsonBody } from "@/lib/api-route";
import { createUrlPreprocessor } from "@/lib/platform-links";
import { prepareLinkSourceDownload, type LinkSourceDownloadAsset } from "@/lib/transcription";

export const runtime = "nodejs";

const REMOTE_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
const DOWNLOAD_SIZE_LIMITS: Record<LinkSourceDownloadAsset["kind"], number> = {
  cover: 20 * 1024 * 1024,
  audio: 500 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024
};
const blockedRemoteContentTypePattern = /^(?:text\/(?:html|plain|xml)|application\/(?:json|problem\+json|xml))/i;

const schema = z.object({
  url: z.preprocess(createUrlPreprocessor({ kind: "video" }), z.string().url()),
  kind: z.enum(["video", "cover", "audio"])
});

export async function POST(request: Request) {
  try {
    const input = await parseJsonBody(request, schema);
    const asset = await prepareLinkSourceDownload(input, { signal: request.signal });

    if (asset.remoteUrl) {
      return await proxyRemoteAsset(asset, request.signal);
    }

    if (asset.filePath) {
      return await streamLocalAsset(asset);
    }

    throw new Error("没有生成可下载文件。");
  } catch (error) {
    return apiError(error, {
      fallbackMessage: "下载失败"
    });
  }
}

async function proxyRemoteAsset(asset: LinkSourceDownloadAsset, signal?: AbortSignal) {
  if (!asset.remoteUrl) throw new Error("缺少远程文件地址。");
  const timeout = createDownloadIdleTimeout(signal);
  let response: Response;

  try {
    response = await fetch(asset.remoteUrl, {
      headers: asset.requestHeaders,
      redirect: "follow",
      signal: timeout.signal
    });
  } catch (error) {
    timeout.clear();
    if (timeout.abortReason === "request") {
      throw new Error("下载已取消。");
    }
    if (timeout.abortReason === "idle") {
      throw new Error(`远程文件下载超时：连续 ${Math.round(REMOTE_DOWNLOAD_IDLE_TIMEOUT_MS / 1000)} 秒没有响应数据。`);
    }
    throw error;
  }

  if (!response.ok) {
    timeout.clear();
    throw new Error(`远程文件下载失败：HTTP ${response.status}`);
  }
  timeout.reset();

  try {
    assertRemoteContentType(response.headers);
    assertDownloadSize(asset, parseContentLength(response.headers.get("content-length")));
  } catch (error) {
    timeout.clear();
    throw error;
  }

  const headers = buildDownloadHeaders(asset, response.headers);
  if (!response.body) {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertDownloadSize(asset, bytes.byteLength);
      return new Response(bytes, { headers });
    } finally {
      timeout.clear();
    }
  }

  return new Response(limitDownloadStream(asset, response.body, timeout), { headers });
}

async function streamLocalAsset(asset: LinkSourceDownloadAsset) {
  if (!asset.filePath) throw new Error("缺少本地文件路径。");
  const stats = await fs.stat(asset.filePath);
  try {
    assertDownloadSize(asset, stats.size);
  } catch (error) {
    await cleanupDownloadAsset(asset.cleanupTargets || [asset.filePath]);
    throw error;
  }
  const fileStream = createReadStream(asset.filePath);
  const cleanup = () => {
    void cleanupDownloadAsset(asset.cleanupTargets || [asset.filePath || ""]);
  };
  fileStream.once("close", cleanup);
  fileStream.once("error", cleanup);

  return new Response(Readable.toWeb(fileStream) as ReadableStream, {
    headers: buildDownloadHeaders(asset, undefined, stats.size)
  });
}

function buildDownloadHeaders(asset: LinkSourceDownloadAsset, upstreamHeaders?: Headers, knownContentLength?: number) {
  const headers = new Headers({
    "Content-Type": upstreamHeaders?.get("content-type") || asset.contentType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
    "Cache-Control": "no-store"
  });
  const contentLength = upstreamHeaders?.get("content-length") || (knownContentLength ? String(knownContentLength) : "");
  if (contentLength) headers.set("Content-Length", contentLength);
  return headers;
}

function assertRemoteContentType(headers: Headers) {
  const contentType = headers.get("content-type")?.trim();
  if (contentType && blockedRemoteContentTypePattern.test(contentType)) {
    throw new Error(`远程文件返回了不可下载的内容类型：${contentType}`);
  }
}

function assertDownloadSize(asset: LinkSourceDownloadAsset, size: number | null) {
  if (!size) return;
  const maxBytes = DOWNLOAD_SIZE_LIMITS[asset.kind];
  if (size > maxBytes) {
    throw new Error(`文件过大，${asset.kind} 下载上限为 ${formatBytes(maxBytes)}，当前文件为 ${formatBytes(size)}。`);
  }
}

function createDownloadIdleTimeout(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortReason: "idle" | "request" | undefined;
  const abortFromRequest = () => {
    abortReason = "request";
    controller.abort();
  };
  const clear = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    parentSignal?.removeEventListener("abort", abortFromRequest);
  };
  const reset = () => {
    clear();
    parentSignal?.addEventListener("abort", abortFromRequest, { once: true });
    if (parentSignal?.aborted) {
      abortFromRequest();
      return;
    }
    timeout = setTimeout(() => {
      abortReason = "idle";
      controller.abort();
    }, REMOTE_DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  reset();
  return {
    signal: controller.signal,
    reset,
    clear,
    get aborted() {
      return controller.signal.aborted;
    },
    get abortReason() {
      return abortReason;
    }
  };
}

function limitDownloadStream(
  asset: LinkSourceDownloadAsset,
  body: ReadableStream<Uint8Array>,
  timeout: ReturnType<typeof createDownloadIdleTimeout>
) {
  let receivedBytes = 0;
  const maxBytes = DOWNLOAD_SIZE_LIMITS[asset.kind];
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        timeout.reset();
        const { done, value } = await reader.read();
        if (done) {
          timeout.clear();
          controller.close();
          return;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) {
          timeout.clear();
          await reader.cancel().catch(() => undefined);
          controller.error(new Error(`文件过大，${asset.kind} 下载上限为 ${formatBytes(maxBytes)}。`));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        timeout.clear();
        controller.error(formatDownloadStreamError(error, timeout));
      }
    },
    cancel(reason) {
      timeout.clear();
      return reader.cancel(reason);
    }
  });
}

function formatDownloadStreamError(error: unknown, timeout: ReturnType<typeof createDownloadIdleTimeout>) {
  if (timeout.abortReason === "request") {
    return new Error("下载已取消。");
  }
  if (timeout.abortReason === "idle") {
    return new Error(`远程文件下载超时：连续 ${Math.round(REMOTE_DOWNLOAD_IDLE_TIMEOUT_MS / 1000)} 秒没有响应数据。`);
  }
  return error;
}

function parseContentLength(value: string | null) {
  if (!value) return null;
  const size = Number.parseInt(value, 10);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024 / 1024)}GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

async function cleanupDownloadAsset(targets: string[]) {
  await Promise.all(
    [...new Set(targets.filter(Boolean))].map((target) =>
      fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    )
  );
}
