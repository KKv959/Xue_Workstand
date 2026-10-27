import { z } from "zod";
import { commentPipelineCheckpointSchema } from "./storage/schemas";

export type CommentPipelineCheckpoint = z.infer<typeof commentPipelineCheckpointSchema>;
type Batch = CommentPipelineCheckpoint["batches"][number];
type Review = NonNullable<Batch["review"]>;

export function pipelineKept(state: CommentPipelineCheckpoint, count: number) {
  return state.batches.flatMap((batch) => batch.review?.filter((row) => row.keep).map((row) => row.text) || []).slice(0, count);
}

/** 整组生成、基础筛选并保存；可选审核供历史恢复和离线诊断使用。 */
export async function runCommentPipeline(input: {
  state: CommentPipelineCheckpoint; count: number; signal?: AbortSignal;
  save: () => Promise<void>;
  generate: (batch: Batch, signal: AbortSignal) => Promise<{ candidates: string[]; model: string; attempts: number }>;
  review?: (comments: string[], kept: string[], signal: AbortSignal) => Promise<Review>;
  select?: (comments: string[], reviewed: string[]) => string[];
  onProgress?: (kept: string[], message: string) => void | Promise<void>;
}) {
  const { state, count, signal = new AbortController().signal } = input;
  // 耗尽后用户主动重试再开放一轮；服务中断恢复沿用已落盘的轮次上限。
  state.roundLimit ??= 2;
  if (state.exhausted) state.roundLimit = state.rounds.length + 1;
  state.exhausted = false;
  if (input.select) {
    const reviewed: string[] = [];
    for (const batch of state.batches) {
      if (!batch.review) continue;
      const selected = input.select(batch.review.filter((row) => row.keep).map((row) => row.text), reviewed);
      batch.reviewCandidates = selected;
      batch.review = selected.map((text) => ({ text, keep: true }));
      reviewed.push(...selected);
    }
  }
  const kept = () => pipelineKept(state, count);
  await input.save();
  while (kept().length < count) {
    signal.throwIfAborted();
    let batch = state.batches.find((row) => row.review === undefined);
    if (!batch) {
      if (state.rounds.length >= state.roundLimit) {
        state.exhausted = true;
        await input.save();
        break;
      }
      const missing = count - kept().length;
      batch = { index: state.batches.length, requestedCount: missing, model: "", attempts: 0 };
      state.batches.push(batch);
      state.rounds.push({ requestedCount: missing, batchIds: [batch.index] });
      await input.save();
      await input.onProgress?.(kept(), state.rounds.length === 1 ? `正在整组生成 ${missing} 条评论` : `仅补写缺少的 ${missing} 条评论`);
    }
    try {
      delete batch.error;
      if (!batch.candidates) {
        Object.assign(batch, await input.generate(batch, signal));
        await input.save();
      }
      signal.throwIfAborted();
      const reviewed = state.batches.flatMap((row) => row.review?.map((item) => item.text) || []);
      batch.reviewCandidates = input.select ? input.select(batch.candidates!, reviewed) : batch.reviewCandidates ?? [...batch.candidates!];
      await input.save();
      await input.onProgress?.(kept(), input.review ? `候选已保存，正在整组质检 ${batch.reviewCandidates.length} 条` : `正在保存 ${batch.reviewCandidates.length} 条生成评论`);
      if (batch.reviewCandidates.length) batch.review = input.review
        ? await input.review(batch.reviewCandidates, kept(), signal)
        : batch.reviewCandidates.map((text) => ({ text, keep: true }));
      else batch.review = [];
      await input.save();
      await input.onProgress?.(kept(), input.review ? `已通过质检 ${kept().length}/${count} 条，成功阶段已保存` : `已保存 ${kept().length}/${count} 条生成评论`);
    } catch (error) {
      batch.error = error instanceof Error ? error.message : "评论生成或保存失败";
      await input.save();
      throw error;
    }
  }
  signal.throwIfAborted();
  return kept();
}
