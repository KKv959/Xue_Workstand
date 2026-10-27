"use client";

import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import { useFeedback } from "@/components/FeedbackProvider";
import { deleteDrafts, draftSummaryFromDraft, getCachedDrafts, getWriterHistoryDraft, getDrafts, renameDraft } from "@/lib/client";
import { buildWriterDraftHref } from "@/lib/draft-links";
import type { Draft, DraftSummary } from "@/lib/types";

export function useWriterHistory(setNotice: (message: string) => void) {
  const [draftSummaries, setDraftSummaries] = useState<DraftSummary[] | null>(() => getCachedDrafts()?.drafts ?? null);
  const [historyLoading, setHistoryLoading] = useState(() => !getCachedDrafts());
  const allDrafts = useMemo(() => draftSummaries || [], [draftSummaries]);
  const historyDrafts = useMemo(() => [...allDrafts].sort(compareCreatedAtDesc), [allDrafts]);

  const handleDraftSaved = useCallback(
    (draft: Draft) => {
      setDraftSummaries((current) => mergeDraftSummaryLists(current || [], [draftSummaryFromDraft(draft)]));
    },
    []
  );

  useEffect(() => {
    let ignore = false;
    if (draftSummaries !== null) return;

    getDrafts()
      .then((result) => {
        if (ignore) return;
        setDraftSummaries((current) => mergeDraftSummaryLists(current || [], result.drafts));
      })
      .catch((err) => {
        if (!ignore) setNotice(err instanceof Error ? err.message : "读取历史记录失败");
      })
      .finally(() => {
        if (!ignore) setHistoryLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [draftSummaries, setNotice]);

  return { historyDrafts, historyLoading, handleDraftSaved, setDraftSummaries };
}

export function useWriterHistoryActions({ historyDrafts, setDraftSummaries, lastDraftId, loadedDraftParamRef, applyLoadedDraft, onClearCurrent, setNotice, refresh }: {
  historyDrafts: DraftSummary[];
  setDraftSummaries: React.Dispatch<React.SetStateAction<DraftSummary[] | null>>;
  lastDraftId: string;
  loadedDraftParamRef: MutableRefObject<string>;
  applyLoadedDraft: (draft: Draft, batch?: Draft[]) => void;
  onClearCurrent: () => void;
  setNotice: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  const router = useRouter();
  const { notify } = useFeedback();
  const handleSelectHistoryDraft = useCallback(
    async (summary: DraftSummary) => {
      try {
        const { draft, batch } = await getWriterHistoryDraft(summary.id);
        loadedDraftParamRef.current = draft.id;
        applyLoadedDraft(draft, batch);
        router.replace(buildWriterDraftHref(draft), { scroll: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取草稿详情失败";
        setNotice(message);
        throw error;
      }
    },
    [applyLoadedDraft, loadedDraftParamRef, router, setNotice]
  );

  const handleDeleteHistoryDraft = useCallback(
    async (draft: DraftSummary) => {
      const replacement = findReplacementDraft(historyDrafts, new Set([draft.id]), draft);

      try {
        await deleteDrafts([draft.id]);
        setDraftSummaries((current) => (current || []).filter((item) => item.id !== draft.id));

        if (draft.id === lastDraftId) {
          if (replacement) {
            await handleSelectHistoryDraft(replacement);
          } else {
            onClearCurrent();
          }
        }

        notify({ tone: "success", message: "草稿已删除。" });
        // LibraryProvider 已展示刷新失败；历史变更本身已成功。
        void refresh().catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : "删除草稿失败";
        notify({ tone: "error", message });
        throw error;
      }
    },
    [
      onClearCurrent,
      setDraftSummaries,
      handleSelectHistoryDraft,
      historyDrafts,
      lastDraftId,
      notify,
      refresh,
    ]
  );

  const handleDeleteHistoryDrafts = useCallback(
    async (draftsToDelete: DraftSummary[]) => {
      const draftIds = draftsToDelete.map((draft) => draft.id);
      const deletedIds = new Set(draftIds);
      const currentDraft = historyDrafts.find((draft) => draft.id === lastDraftId);
      const replacement = findReplacementDraft(historyDrafts, deletedIds, currentDraft);

      try {
        await deleteDrafts(draftIds);
        setDraftSummaries((current) => (current || []).filter((item) => !deletedIds.has(item.id)));

        if (lastDraftId && deletedIds.has(lastDraftId)) {
          if (replacement) {
            await handleSelectHistoryDraft(replacement);
          } else {
            onClearCurrent();
          }
        }

        notify({ tone: "success", message: `已删除 ${draftIds.length} 条草稿。` });
        // LibraryProvider 已展示刷新失败；历史变更本身已成功。
        void refresh().catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : "批量删除草稿失败";
        notify({ tone: "error", message });
        throw error;
      }
    },
    [
      onClearCurrent,
      setDraftSummaries,
      handleSelectHistoryDraft,
      historyDrafts,
      lastDraftId,
      notify,
      refresh,
    ]
  );

  const handleRenameHistoryDraft = useCallback(
    async (draft: DraftSummary, title: string) => {
      try {
        const updatedDraft = await renameDraft({ draftId: draft.id, title });
        setDraftSummaries((current) => mergeDraftSummaryLists(current || [], [draftSummaryFromDraft(updatedDraft)]));
        notify({ tone: "success", message: "草稿名称已更新。" });
        // LibraryProvider 已展示刷新失败；历史变更本身已成功。
        void refresh().catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : "更新草稿名称失败";
        notify({ tone: "error", message });
        throw error;
      }
    },
    [notify, refresh, setDraftSummaries]
  );

  return { handleSelectHistoryDraft, handleDeleteHistoryDraft, handleDeleteHistoryDrafts, handleRenameHistoryDraft };
}

function mergeDraftSummaryLists(...groups: DraftSummary[][]) {
  const byId = new Map<string, DraftSummary>();

  for (const group of groups) {
    for (const draft of group) {
      const current = byId.get(draft.id);
      if (!current) {
        byId.set(draft.id, draft);
        continue;
      }
      if (+new Date(draft.updatedAt) > +new Date(current.updatedAt)) {
        byId.set(draft.id, draft);
      }
    }
  }

  return [...byId.values()].sort(compareCreatedAtDesc);
}

function compareCreatedAtDesc(left: { createdAt: string }, right: { createdAt: string }) {
  return +new Date(right.createdAt) - +new Date(left.createdAt);
}

function findReplacementDraft(drafts: DraftSummary[], deletedIds: Set<string>, currentDraft?: DraftSummary) {
  const remaining = drafts.filter((draft) => !deletedIds.has(draft.id));
  if (!currentDraft) return remaining[0] || null;

  const sessionId = currentDraft.version?.sessionId || currentDraft.id;
  const currentRevision = currentDraft.version?.revision || 1;
  const sameSession = remaining
    .filter((draft) => (draft.version?.sessionId || draft.id) === sessionId)
    .sort((left, right) => {
      const leftDistance = Math.abs((left.version?.revision || 1) - currentRevision);
      const rightDistance = Math.abs((right.version?.revision || 1) - currentRevision);
      return leftDistance - rightDistance || compareCreatedAtDesc(left, right);
    });

  return sameSession[0] || remaining[0] || null;
}
