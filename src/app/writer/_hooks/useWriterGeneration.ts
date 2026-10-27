"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { saveDraft } from "@/lib/client";
import { buildWriterDraftHref } from "@/lib/draft-links";
import { writeCopySourceKey } from "@/lib/job-scope";
import type {
  AccountDraftInput,
  AccountListItem,
  Draft,
  DraftVersion,
  JobRecord,
  JobStartInput,
  ProjectDraftInput,
  WriteBatchResult,
  WriteGenerationResult,
  WriteResult,
  WriteRevisionScope,
  WriteStyleReferenceInput
} from "@/lib/types";

type DraftSaveBase = Omit<AccountDraftInput, "assets" | "content"> | Omit<ProjectDraftInput, "assets" | "content">;
type DraftSaveInput = Omit<AccountDraftInput, "assets"> | Omit<ProjectDraftInput, "assets">;
const PENDING_WRITE_JOB_STORAGE_KEY = "style-workbench-pending-write-job";

type WriterVariantState = {
  key: string;
  title: string;
  content: string;
  research: string;
  savedContent: string;
  draftBase: DraftSaveBase | null;
  draftId: string;
};

export type WriterGeneratedVariant = Pick<WriterVariantState, "key" | "title" | "draftId"> & {
  version?: DraftVersion;
  hasUnsavedChanges: boolean;
};

type UseWriterGenerationInput = {
  activeJobs: JobRecord[];
  activeTitle?: string;
  busy: string;
  hasTaskInput: boolean;
  mode: Draft["mode"];
  normalizedPrompt: string;
  normalizedSourceText: string;
  originalSourceInput: string;
  supportDocLinks: string;
  recentJobs: JobRecord[];
  revisionInstruction: string;
  revisionScope: WriteRevisionScope;
  revisionMode: "edit" | "recalibrate";
  selectedText: string;
  onDraftSaved?: (draft: Draft) => void;
  onRevisionCompleted?: () => void;
  cancelTask: (jobId: string) => Promise<JobRecord>;
  refresh: () => Promise<void>;
  routerPush: (href: string) => void;
  routerReplace: (href: string, options?: { scroll?: boolean }) => void;
  selectedAccount: AccountListItem | null;
  styleRefs: WriteStyleReferenceInput[];
  setBusy: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
  startTask: (input: JobStartInput) => Promise<JobRecord>;
  useWebResearch: boolean;
};

export function useWriterGeneration({
  activeJobs,
  activeTitle,
  busy,
  hasTaskInput,
  mode,
  normalizedPrompt,
  normalizedSourceText,
  originalSourceInput,
  supportDocLinks,
  recentJobs,
  revisionInstruction,
  revisionScope,
  revisionMode,
  selectedText,
  onDraftSaved,
  onRevisionCompleted,
  cancelTask,
  refresh,
  routerPush,
  routerReplace,
  selectedAccount,
  styleRefs,
  setBusy,
  setNotice,
  startTask,
  useWebResearch
}: UseWriterGenerationInput) {
  const [lastContent, setLastContent] = useState("");
  const [lastResearch, setLastResearch] = useState("");
  const [lastSavedContent, setLastSavedContent] = useState("");
  const [lastDraftBase, setLastDraftBase] = useState<DraftSaveBase | null>(null);
  const [lastDraftId, setLastDraftId] = useState("");
  const [generatedVariants, setGeneratedVariants] = useState<WriterVariantState[]>([]);
  const [activeVariantKey, setActiveVariantKey] = useState("");
  const [generateStage, setGenerateStage] = useState("");
  const [activeWriteJobId, setActiveWriteJobId] = useState(readPendingWriteJobId);
  const generationRestoreRef = useRef<(() => void) | null>(null);
  const versionEditsRef = useRef(new Map<string, WriterVariantState>());
  const handledWriteJobsRef = useRef(new Map<string, number>());
  const reportedHydrationErrorsRef = useRef<Set<string>>(new Set());
  const writeJobSourceKey = useMemo(
    () =>
      writeCopySourceKey({
        action: "create",
        targetType: "account",
        platform: selectedAccount?.platform,
        accountId: selectedAccount?.id,
        styleRefs,
        mode,
        prompt: normalizedPrompt,
        sourceText: normalizedSourceText,
        supportDocLinks,
        useWebResearch
      }),
    [
      mode,
      normalizedPrompt,
      normalizedSourceText,
      selectedAccount?.id,
      selectedAccount?.platform,
      styleRefs,
      supportDocLinks,
    useWebResearch
    ]
  );

  const writeJobCandidates = useMemo(
    () => [...activeJobs, ...recentJobs].filter((job) => job.kind === "write-copy"),
    [activeJobs, recentJobs]
  );
  const activeWriteJob = useMemo(() => {
    const tracked = writeJobCandidates.find((job) => job.id === activeWriteJobId);
    if (tracked) return tracked;
    return writeJobCandidates.find((job) =>
      isActiveJob(job) && isCurrentWriteJob(job, selectedAccount?.id, writeJobSourceKey)
    ) || null;
  }, [activeWriteJobId, selectedAccount?.id, writeJobCandidates, writeJobSourceKey]);
  const isGenerating = Boolean(activeWriteJob && isActiveJob(activeWriteJob));
  const canGenerate = Boolean(hasTaskInput && styleRefs.length && lastDraftBase?.targetType !== "project" && !busy && !isGenerating);
  const canRevise = Boolean(
    lastDraftId &&
    lastDraftBase && lastDraftBase.targetType !== "project" &&
    lastContent.trim() &&
    revisionInstruction.trim() &&
    !busy &&
    !isGenerating &&
    (revisionScope === "full" || selectedText.trim())
  );
  const canStopGenerate = Boolean(activeWriteJobId && isGenerating);
  const hasUnsavedChanges = Boolean(lastDraftId && lastContent !== lastSavedContent);
  const hasAnyUnsavedChanges = hasUnsavedChanges || generatedVariants.some((variant) =>
    Boolean(variant.draftId && variant.content !== variant.savedContent)
  );
  const variantSummaries = useMemo<WriterGeneratedVariant[]>(() => generatedVariants.map((variant) => ({
    key: variant.key,
    title: variant.title,
    draftId: variant.draftId,
    version: variant.draftBase?.version,
    hasUnsavedChanges: Boolean(variant.draftId && variant.content !== variant.savedContent)
  })), [generatedVariants]);

  const applyVariantState = useCallback((variant: WriterVariantState) => {
    setActiveVariantKey(variant.key);
    setLastContent(variant.content);
    setLastResearch(variant.research);
    setLastSavedContent(variant.savedContent);
    setLastDraftBase(variant.draftBase);
    setLastDraftId(variant.draftId);
  }, []);

  const updateActiveVariant = useCallback((patch: Partial<WriterVariantState>) => {
    if (!activeVariantKey) return;
    setGeneratedVariants((current) => current.map((variant) =>
      variant.key === activeVariantKey ? { ...variant, ...patch } : variant
    ));
  }, [activeVariantKey]);

  const selectGeneratedVariant = useCallback((variantKey: string) => {
    const target = generatedVariants.find((variant) => variant.key === variantKey);
    if (!target || target.key === activeVariantKey) return;
    applyVariantState(target);
  }, [activeVariantKey, applyVariantState, generatedVariants]);

  // Preserve every independently edited style variant during history browsing and failed generation.
  const captureEditingState = useCallback(() => () => {
    setLastContent(lastContent);
    setLastResearch(lastResearch);
    setLastSavedContent(lastSavedContent);
    setLastDraftBase(lastDraftBase);
    setLastDraftId(lastDraftId);
    setGeneratedVariants(generatedVariants);
    setActiveVariantKey(activeVariantKey);
  }, [activeVariantKey, generatedVariants, lastContent, lastDraftBase, lastDraftId, lastResearch, lastSavedContent]);

  const restoreGenerationState = useCallback(() => {
    generationRestoreRef.current?.();
    generationRestoreRef.current = null;
  }, []);

  useEffect(() => {
    if (!activeWriteJob) return;
    setActiveWriteJobId(activeWriteJob.id);
    setGenerateStage(activeWriteJob.message || "正在生成文案");
    if (isActiveJob(activeWriteJob)) {
      if (activeWriteJob.partialText) setLastContent(activeWriteJob.partialText);
      setBusy("generate");
      return;
    }

    const result = activeWriteJob.result as WriteGenerationResult | undefined;
    const isWaitingForHydratedResult = !result && Boolean((activeWriteJob as { hasResult?: boolean }).hasResult);
    if (isWaitingForHydratedResult) {
      if (activeWriteJob.error) {
        restoreGenerationState();
        setBusy("");
        setGenerateStage("结果同步失败");
        if (!reportedHydrationErrorsRef.current.has(activeWriteJob.id)) {
          reportedHydrationErrorsRef.current.add(activeWriteJob.id);
          setNotice(activeWriteJob.error);
        }
        return;
      }
      setGenerateStage("正在同步生成结果");
      return;
    }

    const dataRevision = activeWriteJob.dataRevision || 0;
    if (handledWriteJobsRef.current.has(activeWriteJob.id)) {
      if (dataRevision > handledWriteJobsRef.current.get(activeWriteJob.id)!) {
        handledWriteJobsRef.current.set(activeWriteJob.id, dataRevision);
        const saved = result ? isWriteBatchResult(result) ? result.results : [result] : [];
        for (const item of saved) if (item.draft) onDraftSaved?.(item.draft);
        if (saved.some(item => item.draft)) {
          void refresh();
          setNotice("停止前已完成的稿件已保存到版本历史，当前编辑已保留。");
        }
      }
      return;
    }
    handledWriteJobsRef.current.set(activeWriteJob.id, dataRevision);
    clearPendingWriteJobId(activeWriteJob.id);
    if (activeWriteJob.status === "completed") setActiveWriteJobId("");
    setBusy("");

    if (activeWriteJob.status === "completed" || (result && (isWriteBatchResult(result) ? result.results.length > 0 : Boolean(result.draft)))) {
      if (result) {
        generationRestoreRef.current = null;
        if (isWriteBatchResult(result)) {
          const isRevisionBatch = result.results.every(item => item.draft?.version?.origin === "revision");
          const nextVariants = isRevisionBatch && generatedVariants.length
            ? generatedVariants.map(variant => {
              const item = result.results.find(item => item.draft?.version?.parentDraftId === variant.draftId);
              return item ? { ...variantStateFromWriteResult(item), key: variant.key, title: variant.title } : variant;
            })
            : result.results.map((item) => variantStateFromWriteResult(item));
          setGeneratedVariants(nextVariants);
          const selected = nextVariants.find(item => item.key === activeVariantKey) || nextVariants[0];
          if (selected) applyVariantState(selected);
          for (const item of result.results) {
            if (item.draft) onDraftSaved?.(item.draft);
          }
          void refresh();
          const failureNotice = result.failures.length
            ? `；${result.failures.map((failure) => `${failure.styleTitle}失败`).join("、")}`
            : "";
          setNotice(`已${isRevisionBatch ? "修改" : "生成"}并保存 ${result.results.length} 篇独立文案${failureNotice}${activeWriteJob.status !== "completed" ? "；任务已中止，未完成稿件保留原文" : ""}。`);
        } else {
          const nextVariant = variantStateFromWriteResult(result, activeTitle || "当前稿件", activeVariantKey);
          const isRevision = result.draft?.version?.origin === "revision";
          if (isRevision && activeVariantKey && generatedVariants.length > 1) {
            setGeneratedVariants((current) => current.map((variant) =>
              variant.key === activeVariantKey ? { ...nextVariant, key: variant.key, title: variant.title } : variant
            ));
            applyVariantState({ ...nextVariant, key: activeVariantKey, title: generatedVariants.find((item) => item.key === activeVariantKey)?.title || nextVariant.title });
          } else {
            setGeneratedVariants([nextVariant]);
            applyVariantState(nextVariant);
          }
          if (result.draft) {
            onDraftSaved?.(result.draft);
            if (generatedVariants.length <= 1) routerReplace(buildWriterDraftHref(result.draft), { scroll: false });
            if (isRevision) onRevisionCompleted?.();
            void refresh();
          }
          setNotice(
            `${result.fallback ? result.fallbackReason || "模型暂不可用，已用本地模板生成，可继续编辑。" : `已调用 ${result.usedModel}${useWebResearch ? "，已启用联网检索" : ""}。`}已自动保存到版本历史。${activeWriteJob.status !== "completed" ? "任务已中止，已完成版本已保留。" : ""}`
          );
        }
      } else {
        generationRestoreRef.current = null;
        setNotice("文案生成完成。");
      }
      setGenerateStage(activeWriteJob.status === "completed" ? "生成完成" : "已中止，结果已保存");
      return;
    }

    if (activeWriteJob.status === "failed" || activeWriteJob.status === "interrupted") {
      restoreGenerationState();
      const interrupted = activeWriteJob.status === "interrupted";
      setNotice(activeWriteJob.error || (interrupted ? "生成任务已中断，已恢复生成前的编辑内容，请重试。" : "生成失败，请检查模型配置、代理或输入内容后重试。"));
      setGenerateStage(interrupted ? "生成已中断" : "生成失败");
      return;
    }

    if (activeWriteJob.status === "cancelled") {
      restoreGenerationState();
      setNotice("已停止本次生成，版本历史不会新增未完成内容。");
      setGenerateStage("已停止");
    }
  }, [
    activeTitle,
    activeVariantKey,
    activeWriteJob,
    applyVariantState,
    generatedVariants,
    onDraftSaved,
    onRevisionCompleted,
    refresh,
    restoreGenerationState,
    routerReplace,
    setBusy,
    setNotice,
    useWebResearch
  ]);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    generationRestoreRef.current = captureEditingState();
    setBusy("generate");
    setNotice("");
    setGenerateStage("准备写作任务");
    setLastContent("");
    setLastResearch("");
    setLastSavedContent("");
    setLastDraftBase(null);
    setLastDraftId("");
    setGeneratedVariants([]);
    setActiveVariantKey("");

    try {
      const job = await startTask({
        kind: "write-copy",
        title: styleRefs.length > 1 ? `并发生成 ${styleRefs.length} 篇文案` : "生成文案",
        inputSummary: activeTitle
          ? `${activeTitle} · ${mode === "topic" ? "自由输入" : "素材改写"}${styleRefs.length > 1 ? ` · ${styleRefs.length} 篇` : ""}`
          : undefined,
        href: "/writer",
        input: {
          action: "create",
          targetType: "account",
          platform: selectedAccount?.platform,
          accountId: selectedAccount?.id,
          styleRefs,
          mode,
          prompt: normalizedPrompt,
          originalSourceInput,
          sourceText: normalizedSourceText,
          supportDocLinks: supportDocLinks.trim() || undefined,
          save: true,
          useWebResearch
        }
      });
      rememberPendingWriteJobId(job.id);
      setActiveWriteJobId(job.id);
      setGenerateStage(job.message);
      setNotice(styleRefs.length > 1
        ? `${styleRefs.length} 张风格卡已开始并发生成，每张会得到一篇独立文案。`
        : "文案生成已在后台开始，可以切换到其他模块。");
    } catch (err) {
      restoreGenerationState();
      setNotice(err instanceof Error ? err.message : "生成失败，请检查模型配置、代理或输入内容后重试。");
      setGenerateStage("任务启动失败");
      setActiveWriteJobId("");
      setBusy("");
    }
  }, [
    activeTitle,
    canGenerate,
    captureEditingState,
    mode,
    normalizedPrompt,
    normalizedSourceText,
    originalSourceInput,
    restoreGenerationState,
    selectedAccount,
    styleRefs,
    setBusy,
    setNotice,
    startTask,
    supportDocLinks,
    useWebResearch
  ]);

  const handleRevise = useCallback(async (variantKeys?: string[]) => {
    if (!canRevise || !lastDraftBase || lastDraftBase.targetType === "project") return;
    const targets = variantKeys?.length ? generatedVariants.filter(item => variantKeys.includes(item.key)) : [];
    if (variantKeys && (!targets.length || targets.some(item => !item.draftId || !item.content.trim()))) {
      setNotice("请选择有正文的稿件后再修改。");
      return;
    }
    generationRestoreRef.current = captureEditingState();
    setBusy("generate");
    setNotice("");
    setGenerateStage("准备续改任务");

    try {
      const job = await startTask({
        kind: "write-copy",
        title: "继续修改文案",
        inputSummary: `V${(lastDraftBase.version?.revision || 1) + 1} · ${revisionScope === "selection" ? "选中段落" : "全文"}`,
        href: "/writer",
        input: {
          action: "revise",
          targetType: "account",
          platform: lastDraftBase.platform,
          accountId: lastDraftBase.accountId,
          mode: lastDraftBase.mode,
          prompt: lastDraftBase.prompt,
          sourceText: lastDraftBase.input,
          save: true,
          parentDraftId: lastDraftId,
          revisionTargets: targets.length ? targets.map(item => ({ parentDraftId: item.draftId, currentContent: item.key === activeVariantKey ? lastContent : item.content })) : undefined,
          currentContent: lastContent,
          revisionInstruction: revisionInstruction.trim(),
          revisionScope: targets.length ? "full" : revisionScope,
          revisionMode,
          selectedText: revisionScope === "selection" ? selectedText : undefined
        }
      });
      rememberPendingWriteJobId(job.id);
      setActiveWriteJobId(job.id);
      setGenerateStage(job.message);
      setNotice("续改任务已开始，完成后会新增一个版本。");
    } catch (err) {
      restoreGenerationState();
      setNotice(err instanceof Error ? err.message : "续改任务启动失败，请稍后重试。");
      setGenerateStage("任务启动失败");
      setActiveWriteJobId("");
      setBusy("");
    }
  }, [
    canRevise,
    captureEditingState,
    generatedVariants,
    activeVariantKey,
    lastContent,
    lastDraftBase,
    lastDraftId,
    revisionInstruction,
    revisionScope,
    revisionMode,
    restoreGenerationState,
    selectedText,
    setBusy,
    setNotice,
    startTask
  ]);

  const handleStopGenerate = useCallback(async () => {
    if (!activeWriteJobId) return;
    try {
      await cancelTask(activeWriteJobId);
      setNotice("正在停止生成任务…");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "停止生成失败，请稍后重试。");
    }
  }, [activeWriteJobId, cancelTask, setNotice]);

  const saveCurrentContent = useCallback(async () => {
    if (!lastContent || !lastDraftBase) return null;
    if (lastDraftId && lastSavedContent === lastContent) return { draftId: lastDraftId, draft: null };

    const version = nextManualDraftVersion(lastDraftBase, lastDraftId);
    const payload: DraftSaveInput = { ...lastDraftBase, version, content: lastContent };
    const draft = await saveDraft(payload);
    setLastDraftId(draft.id);
    setLastSavedContent(lastContent);
    setLastDraftBase(draftToSaveBase(draft));
    updateActiveVariant({
      savedContent: lastContent,
      draftId: draft.id,
      draftBase: draftToSaveBase(draft)
    });
    onDraftSaved?.(draft);
    if (generatedVariants.length <= 1) routerReplace(buildWriterDraftHref(draft), { scroll: false });
    await refresh();
    return { draftId: draft.id, draft };
  }, [
    generatedVariants.length,
    lastContent,
    lastDraftBase,
    lastDraftId,
    lastSavedContent,
    onDraftSaved,
    refresh,
    routerReplace,
    updateActiveVariant
  ]);

  const handleSaveEdit = useCallback(async () => {
    if (!hasUnsavedChanges) return;
    setBusy("save-draft");
    setNotice("");
    try {
      const saved = await saveCurrentContent();
      if (saved?.draft) setNotice(`手动编辑已保存为 V${saved.draft.version?.revision || 1}。`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "保存编辑失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }, [hasUnsavedChanges, saveCurrentContent, setBusy, setNotice]);

  const handleOpenAssets = useCallback(async () => {
    if (!lastContent || !lastDraftBase) return;
    setBusy("assets");
    setNotice("");
    try {
      const saved = await saveCurrentContent();
      if (!saved?.draftId) throw new Error("当前稿件尚未保存");
      routerPush(`/assets?draftId=${encodeURIComponent(saved.draftId)}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "打开评论生成失败，请先保存当前结果后重试。");
    } finally {
      setBusy("");
    }
  }, [lastContent, lastDraftBase, routerPush, saveCurrentContent, setBusy, setNotice]);

  const copyLast = useCallback(async () => {
    if (!lastContent) return;
    await navigator.clipboard.writeText(lastContent);
    setNotice("生成结果已复制到剪贴板。");
  }, [lastContent, setNotice]);

  const handleContentChange = useCallback((content: string) => {
    setLastContent(content);
    updateActiveVariant({ content });
  }, [updateActiveVariant]);

  const loadDraftResult = useCallback((draft: Draft, batch: Draft[] = [draft]) => {
    generationRestoreRef.current = null;
    const variant = variantStateFromDraft(draft);
    setGeneratedVariants(batch.map(variantStateFromDraft));
    applyVariantState(variant);
    setGenerateStage("");
  }, [applyVariantState]);

  const loadDraftVersion = useCallback((draft: Draft) => {
    const current = generatedVariants.find(item => item.key === activeVariantKey);
    if (current) versionEditsRef.current.set(current.draftId, { ...current, content: lastContent });
    const variant = { ...(versionEditsRef.current.get(draft.id) || variantStateFromDraft(draft)), key: activeVariantKey || draft.id };
    setGeneratedVariants(current => current.length ? current.map(item => item.key === activeVariantKey ? variant : item) : [variant]);
    applyVariantState(variant);
  }, [activeVariantKey, applyVariantState, generatedVariants, lastContent]);

  const clearDraftResult = useCallback(() => {
    generationRestoreRef.current = null;
    setLastContent("");
    setLastResearch("");
    setLastSavedContent("");
    setLastDraftBase(null);
    setLastDraftId("");
    setGeneratedVariants([]);
    setActiveVariantKey("");
    setGenerateStage("");
    clearPendingWriteJobId(activeWriteJobId);
    setActiveWriteJobId("");
  }, [activeWriteJobId]);

  return {
    captureEditingState,
    canGenerate,
    canRevise,
    canStopGenerate,
    clearDraftResult,
    copyLast,
    generateStage,
    activeVariantKey,
    generatedVariants: variantSummaries,
    handleContentChange,
    handleGenerate,
    handleOpenAssets,
    handleRevise,
    handleSaveEdit,
    handleStopGenerate,
    hasAnyUnsavedChanges,
    hasUnsavedChanges,
    lastContent,
    lastDraftBase,
    lastDraftId,
    lastDraftVersion: lastDraftBase?.version,
    lastResearch,
    loadDraftResult,
    loadDraftVersion,
    selectGeneratedVariant
  };
}

function isWriteBatchResult(result: WriteGenerationResult): result is WriteBatchResult {
  return "kind" in result && result.kind === "write-batch";
}

function variantStateFromWriteResult(
  result: WriteResult,
  fallbackTitle = "当前稿件",
  fallbackKey = ""
): WriterVariantState {
  const metadata = result as WriteResult & { styleKey?: string; styleTitle?: string };
  return {
    key: metadata.styleKey || fallbackKey || result.draft?.id || "current",
    title: metadata.styleTitle || fallbackTitle,
    content: result.content,
    research: result.research || "",
    savedContent: result.draft ? result.content : "",
    draftBase: result.draft ? draftToSaveBase(result.draft) : null,
    draftId: result.draft?.id || ""
  };
}

function variantStateFromDraft(draft: Draft): WriterVariantState {
  return {
    key: draft.id,
    title: draft.targetType === "project" ? draft.projectName : draft.accountName,
    content: draft.content,
    research: draft.research || "",
    savedContent: draft.content,
    draftBase: draftToSaveBase(draft),
    draftId: draft.id
  };
}

function nextManualDraftVersion(base: DraftSaveBase, parentDraftId: string): DraftVersion {
  return {
    sessionId: base.version?.sessionId || parentDraftId,
    batchId: base.version?.batchId,
    parentDraftId,
    revision: (base.version?.revision || 1) + 1,
    instruction: "手动编辑",
    contextFingerprint: base.version?.contextFingerprint || `legacy-${parentDraftId}`,
    promptVersion: base.version?.promptVersion || "writer-v2",
    origin: "manual_edit"
  };
}

function draftToSaveBase(draft: Draft): DraftSaveBase {
  const shared = {
    title: draft.title,
    mode: draft.mode,
    prompt: draft.prompt,
    originalSourceInput: draft.originalSourceInput,
    input: draft.input,
    supportDocLinks: draft.supportDocLinks,
    brief: draft.brief,
    research: draft.research,
    sourceDigest: draft.sourceDigest,
    writerContext: draft.writerContext,
    styleRefs: draft.styleRefs,
    version: draft.version
  };

  if (draft.targetType === "project") {
    return {
      ...shared,
      targetType: "project",
      projectId: draft.projectId,
      projectName: draft.projectName,
      styleRef: draft.styleRef
    };
  }

  return {
    ...shared,
    platform: draft.platform,
    accountId: draft.accountId,
    accountName: draft.accountName,
    styleRef: draft.styleRef
  };
}

function isCurrentWriteJob(
  job: JobRecord,
  accountId?: string,
  sourceKey?: string
) {
  if (job.scope?.targetType !== "account") return false;
  if (sourceKey && job.scope.sourceKey !== sourceKey) return false;
  return Boolean(accountId && job.scope.accountId === accountId);
}

function isActiveJob(job: JobRecord) {
  return job.status === "queued" || job.status === "running";
}

function readPendingWriteJobId() {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(PENDING_WRITE_JOB_STORAGE_KEY) || "";
}

function rememberPendingWriteJobId(jobId: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(PENDING_WRITE_JOB_STORAGE_KEY, jobId);
}

function clearPendingWriteJobId(jobId: string) {
  if (typeof window === "undefined" || !jobId) return;
  if (window.sessionStorage.getItem(PENDING_WRITE_JOB_STORAGE_KEY) === jobId) {
    window.sessionStorage.removeItem(PENDING_WRITE_JOB_STORAGE_KEY);
  }
}
