export const SOURCE_VIDEO_COMMENT_THRESHOLD = 20;

/** 只接受明确的评论计数；缺失值不能当成零或用点赞、弹幕数替代。 */
export function sourceCommentCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value.trim()))) continue;
    const count = Number(value);
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  return undefined;
}

/** 批量核验：一次浏览器调用返回多条结果；单条失败以 Error 表示，不影响同批其他视频。 */
export type CommentCountBatchResolver<T> = {
  batchSize: number;
  resolveMany: (videos: T[]) => Promise<Map<string, number | undefined | Error>>;
};

export async function selectEligibleCommentSources<T extends { id: string; commentCount?: number }>(
  candidates: T[], limit: number,
  resolveCount: ((video: T) => Promise<number | undefined>) | CommentCountBatchResolver<T>,
  signal?: AbortSignal
) {
  const videos: T[] = [];
  const errors: string[] = [];
  const batchSize = typeof resolveCount === "function" ? 1 : Math.max(1, resolveCount.batchSize);
  const resolveMany = typeof resolveCount === "function"
    ? async ([video]: T[]) => new Map([[video.id, await resolveCount(video)]])
    : resolveCount.resolveMany;
  const isAbort = (error: unknown) => signal?.aborted || (error instanceof Error && error.name === "AbortError");
  // 按排名分块核验，凑够 limit 个合格来源即停止，不提前核验后面的候选。
  for (let start = 0; start < candidates.length && videos.length < limit; start += batchSize) {
    signal?.throwIfAborted();
    const chunk = candidates.slice(start, start + batchSize);
    const pending = chunk.filter((video) => video.commentCount === undefined);
    let resolved: Map<string, number | undefined | Error>;
    try {
      resolved = pending.length ? await resolveMany(pending) : new Map();
    } catch (error) {
      if (isAbort(error)) throw error;
      const failure = error instanceof Error ? error : new Error(String(error));
      resolved = new Map(pending.map((video) => [video.id, failure]));
    }
    signal?.throwIfAborted();
    for (const video of chunk) {
      if (videos.length >= limit) break;
      const value = video.commentCount ?? resolved.get(video.id);
      if (value instanceof Error) {
        errors.push(`${video.id}：评论总数核验失败，已跳过：${value.message}`);
        if (/401|403|412|429|444|登录|验证码|风控/.test(value.message)) return { videos, errors };
        continue;
      }
      const count = sourceCommentCount(value);
      if (count === undefined || count <= SOURCE_VIDEO_COMMENT_THRESHOLD) {
        errors.push(`${video.id}：${count === undefined ? "无法确认评论总数" : `评论总数 ${count} 条`}，要求超过 ${SOURCE_VIDEO_COMMENT_THRESHOLD} 条，已跳过`);
        continue;
      }
      videos.push({ ...video, commentCount: count });
    }
  }
  return { videos, errors };
}

export type CommentPageTrace = {
  cursor: number;
  nextCursor: number;
  returnedCount: number;
  addedCount: number;
  hasMore: boolean;
};

export type CommentCollectionAttempt = {
  videoId: string;
  requestedCount: number;
  collectedCount: number;
  acceptedCount?: number;
  pages: CommentPageTrace[];
  stopReason: "target_reached" | "exhausted" | "failed" | "cancelled";
  elapsedMs: number;
  error?: string;
};

export function commentCorpusKey(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 两个平台共享实际去重数量，先各尝试两个来源，再按缺口补已有候选。 */
export function createCommentCollectionBudget(target = 600) {
  const seen = new Set<string>();
  return {
    target,
    get count() { return seen.size; },
    needsMore: () => seen.size < target,
    add(texts: string[]) {
      for (const text of texts) {
        const key = commentCorpusKey(text);
        if (key) seen.add(key);
      }
    }
  };
}

export type CommentCollectionBudget = ReturnType<typeof createCommentCollectionBudget>;

/** 初选不足时只使用已有搜索候选补充，不重新规划或无限采集。 */
export async function collectCommentSources<T, R>(input: {
  candidates: T[];
  sourceTarget: number;
  read: (video: T) => Promise<R>;
  count: (result: R) => number;
  shouldStop?: () => boolean;
  budget?: CommentCollectionBudget;
  signal?: AbortSignal;
  deadlineMs?: number;
  concurrency?: number;
}) {
  const videos: T[] = [];
  const results: R[] = [];
  let sources = 0;
  let attempts = 0;
  const concurrency = Math.max(1, Math.min(input.concurrency || 1, 4));
  const deadlineReached = () => Boolean(input.deadlineMs && Date.now() >= input.deadlineMs);
  // 按波次并发读取，波次之间才重新判断预算和截止，避免超读过多来源。
  for (let start = 0; start < input.candidates.length; start += concurrency) {
    input.signal?.throwIfAborted();
    const complete = input.budget
      ? attempts >= input.sourceTarget && !input.budget.needsMore()
      : sources >= input.sourceTarget;
    if (input.shouldStop?.() || complete || deadlineReached()) break;
    const wave = input.candidates.slice(start, start + concurrency);
    attempts += wave.length;
    const rows = await Promise.all(wave.map(async (video) => {
      const result = await input.read(video);
      return { video, result, count: input.count(result) };
    }));
    for (const row of rows) {
      if (row.count <= 0) continue;
      videos.push(row.video);
      results.push(row.result);
      sources += 1;
    }
  }
  return { videos, results };
}
