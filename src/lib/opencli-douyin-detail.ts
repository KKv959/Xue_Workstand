import { buildDouyinVideoUrl, extractDouyinAwemeId, isLikelyDirectMediaUrl, normalizeLinkInput, normalizeRemoteImageUrl } from "./platform-links";
import { parseJsonish, runPersistentOpenCliBrowserAdapter, type OpenCliTimingOptions } from "./opencli-runtime";

export type DouyinSingleVideoReference = {
  id: string;
  url: string;
  title: string;
  authorName: string;
  authorSecUid: string;
  coverUrl: string;
  mediaUrl: string;
};

/** Single-work reads only; account pagination and batch media prefetch keep their own paths. */
export async function getDouyinSingleVideoReference(
  input: string,
  options: OpenCliTimingOptions = {}
): Promise<DouyinSingleVideoReference> {
  if (options.signal?.aborted) {
    const error = new Error("任务已停止"); error.name = "AbortError"; throw error;
  }
  const target = normalizeLinkInput(input);
  if (!/^\d{16,20}$/.test(target)) {
    let parsed: URL;
    try { parsed = new URL(target); } catch { throw new Error("抖音详情读取需要单条作品链接或作品 ID。"); }
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password ||
      !["douyin.com", "www.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"].includes(parsed.hostname)) {
      throw new Error("抖音详情读取只支持 HTTPS 抖音作品链接，请检查输入。");
    }
  }
  let raw: unknown;
  try {
    const stdout = await runPersistentOpenCliBrowserAdapter(["douyin", "detail", target, "-f", "json"], {
      ...options, timeout: 45_000, timingStage: "douyin.detail.single"
    });
    raw = parseJsonish(stdout);
  } catch (error) {
    if (options.signal?.aborted || error instanceof Error && error.name === "AbortError") throw error;
    throw new Error(`抖音单条作品读取失败：${error instanceof Error ? error.message : String(error)}。请检查 Chrome 抖音登录状态及作品是否可访问。`, { cause: error });
  }
  if (!Array.isArray(raw)) throw new Error("抖音详情返回了无效结果，请检查 OpenCLI 版本后重试。");
  const rows = raw;
  const row = rows.length === 1 && rows[0] && typeof rows[0] === "object" ? rows[0] as Record<string, unknown> : null;
  const id = row && typeof row.aweme_id === "string" ? row.aweme_id : "";
  const expectedId = extractDouyinAwemeId(target);
  if (!row || !/^\d{16,20}$/.test(id) || expectedId && id !== expectedId) {
    throw new Error("抖音详情返回的作品 ID 缺失或与输入不匹配，请检查链接后重试。");
  }
  const mediaUrl = typeof row.play_url === "string" ? row.play_url.trim() : "";
  if (!mediaUrl && Array.isArray(row.images) && row.images.length) {
    throw new Error("这条抖音作品是图文图集，没有可转写的视频音轨，请提供视频作品链接。");
  }
  if (!mediaUrl || !isLikelyDirectMediaUrl(mediaUrl)) {
    throw new Error("抖音详情没有返回有效视频媒体地址，请确认作品可播放后重试。");
  }
  return {
    id, url: buildDouyinVideoUrl(id), mediaUrl,
    title: typeof row.desc === "string" ? row.desc.trim() : "",
    authorName: typeof row.author === "string" ? row.author.trim() : "",
    authorSecUid: typeof row.author_sec_uid === "string" ? row.author_sec_uid.trim() : "",
    coverUrl: normalizeRemoteImageUrl(typeof row.cover === "string" ? row.cover : "")
  };
}
