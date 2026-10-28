"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import { Suspense, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BookOpenText,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Copy,
  Eye,
  FileText,
  FileUp,
  Globe2,
  History,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  Save,
  Send,
  Sparkles,
  X
} from "lucide-react";
import { splitWriterSourceItems } from "./_lib/source-items";
import { FeishuResultModal } from "./_components/FeishuResultModal";
import { WriterPreference } from "./_components/WriterPreference";
import { WriterPromptField } from "./_components/WriterPromptField";
import { WriterDialogModal } from "./_components/WriterDialogModal";
import { WriterHistoryPanel } from "./_components/WriterHistoryPanel";
import { WriterActionMenu } from "./_components/WriterActionMenu";
import { WriterReferencePicker } from "./_components/WriterReferencePicker";
import { WriterStyleModal } from "./_components/WriterStyleModal";
import { useWriterHistory, useWriterHistoryActions } from "./_hooks/useWriterHistory";
import { useWriterSessionSave } from "./_hooks/useWriterSessionSave";
import { buildWriterDraftHref } from "@/lib/draft-links";
import { useFeishuPublish } from "./_hooks/useFeishuPublish";
import { useWriterGeneration } from "./_hooks/useWriterGeneration";
import { useWriterReferenceDetails } from "./_hooks/useWriterReferenceDetails";
import { EmptyState } from "@/components/EmptyState";
import { useFeedback } from "@/components/FeedbackProvider";
import { useLibrary } from "@/components/LibraryProvider";
import { useRemoteStatus } from "@/components/RemoteStatusProvider";
import { useScopedTasks } from "@/components/TaskProvider";
import { isTaskProgressMessage } from "@/lib/feedback-messages";
import {
  getWriterHistoryDraft,
  getDraft,
  uploadWriterSourceFiles
} from "@/lib/client";
import {
  draftWriteStyleReferenceInputs,
  parseWriteStyleReferenceKey,
  writeStyleReferenceKey
} from "@/lib/write-references";
import {
  extractRewriteSourceMaterial,
  mergeWriterSourceInput,
  normalizeRewritePrompt,
  restoreWriterSourceInput,
  splitWriterSourceInput
} from "@/lib/source-extraction";
import { appendWriterSourceFiles, WRITER_SOURCE_FILE_ACCEPT } from "@/lib/source-file-import";
import { formatLongDraftForDisplay, LONG_DRAFT_DISPLAY_THRESHOLD } from "@/lib/writer-display";
import type {
  AccountListItem,
  Draft,
  WriteRevisionScope,
  WriteStyleReferenceInput
} from "@/lib/types";

const WRITER_SESSION_DRAFT_KEY = "writer-mobile-session-draft-v1";
const EMPTY_ACCOUNTS: AccountListItem[] = [];

export default function WriterPage() {
  return (
    <Suspense fallback={<WriterFallback />}>
      <WriterPageContent />
    </Suspense>
  );
}

function WriterPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { library, loading, refresh } = useLibrary();
  const { activeJobs, cancelTask, recentJobs, startTask } = useScopedTasks({
    href: "/writer",
    kinds: ["write-copy"]
  });
  const { notify } = useFeedback();
  const remoteStatus = useRemoteStatus();
  const [styleRefs, setStyleRefs] = useState<WriteStyleReferenceInput[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [useWebResearch, setUseWebResearch] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [revisionScope, setRevisionScope] = useState<WriteRevisionScope>("full");
  const [revisionMode, setRevisionMode] = useState<"edit" | "recalibrate">("edit");
  const [selectedDraftText, setSelectedDraftText] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [styleOpen, setStyleOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySessionId, setHistorySessionId] = useState("");
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const [sourceDragActive, setSourceDragActive] = useState(false);
  const [sourceImporting, setSourceImporting] = useState(false);
  const [sessionDraftHydrated, setSessionDraftHydrated] = useState(false);
  const [draftEditing, setDraftEditing] = useState(false);
  const loadedDraftParamRef = useRef("");
  const appliedSearchParamRef = useRef("");
  const draftEditorRef = useRef<HTMLTextAreaElement>(null);
  const revisionInputRef = useRef<HTMLTextAreaElement>(null);
  const sourceDragDepthRef = useRef(0);
  const sourceFileInputRef = useRef<HTMLInputElement>(null);
  const webResearchCapability = remoteStatus.status?.capabilities.webResearch;
  const webResearchAvailable = webResearchCapability?.available === true;

  useEffect(() => {
    if (webResearchCapability && !webResearchCapability.available) {
      setUseWebResearch(false);
    }
  }, [webResearchCapability]);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(WRITER_SESSION_DRAFT_KEY);
      if (saved) {
        const draft = JSON.parse(saved) as Partial<{
          accountId: string;
          styleRefs: WriteStyleReferenceInput[];
          prompt: string;
          sourceText: string;
          supportDocLinks: string;
          useWebResearch: boolean;
          revisionInstruction: string;
          revisionMode?: "edit" | "recalibrate";
        }>;
        if (Array.isArray(draft.styleRefs) && draft.styleRefs.length) {
          setStyleRefs(draft.styleRefs.filter(reference => reference.targetType === "account"));
        } else if (typeof draft.accountId === "string") {
          const platform = draft.accountId.split(":")[0];
          if (platform === "bilibili" || platform === "douyin") {
            setStyleRefs([{ targetType: "account", platform, accountId: draft.accountId }]);
          }
        }
        if (typeof draft.prompt === "string") setPrompt(draft.prompt);
        if (typeof draft.sourceText === "string" || typeof draft.supportDocLinks === "string") {
          setSourceText(mergeWriterSourceInput(draft.sourceText, draft.supportDocLinks));
        }
        if (typeof draft.useWebResearch === "boolean") setUseWebResearch(draft.useWebResearch);
        if (draft.revisionMode === "edit" || draft.revisionMode === "recalibrate") setRevisionMode(draft.revisionMode);
        if (typeof draft.revisionInstruction === "string") setRevisionInstruction(draft.revisionInstruction);
      }
    } catch {
      window.sessionStorage.removeItem(WRITER_SESSION_DRAFT_KEY);
    } finally {
      setSessionDraftHydrated(true);
    }
  }, []);

  useWriterSessionSave(WRITER_SESSION_DRAFT_KEY, sessionDraftHydrated, {
    styleRefs, prompt, sourceText, useWebResearch, revisionInstruction, revisionMode
  }, setNotice);

  const selectedStyleRefs = useMemo(() => {
    const availableKeys = new Set([
      ...(library?.accounts || EMPTY_ACCOUNTS).map((account) => writeStyleReferenceKey({
        targetType: "account" as const,
        platform: account.platform,
        accountId: account.id
      })),
    ]);
    const selected = styleRefs.filter((reference) => availableKeys.has(writeStyleReferenceKey(reference)));
    if (selected.length) return selected;
    const firstAccount = library?.accounts[0];
    if (firstAccount) return [{ targetType: "account" as const, platform: firstAccount.platform, accountId: firstAccount.id }];
    return [];
  }, [library?.accounts, styleRefs]);
  const primaryStyleRef = selectedStyleRefs[0];
  const selectedAccount = useMemo(() => primaryStyleRef?.targetType === "account"
    ? library?.accounts.find((account) => account.id === primaryStyleRef.accountId && account.platform === primaryStyleRef.platform) || null
    : null, [library?.accounts, primaryStyleRef]);

  const { historyDrafts, historyLoading, handleDraftSaved, setDraftSummaries } = useWriterHistory(setNotice);

  const { activeStyleLoading, activeStyleError, activeTitle, styleCards } = useWriterReferenceDetails({
    accounts: library?.accounts || EMPTY_ACCOUNTS,
    references: selectedStyleRefs,
    setNotice
  });
  const separatedSourceInput = useMemo(() => splitWriterSourceInput(sourceText), [sourceText]);
  const sourceExtraction = useMemo(
    () => extractRewriteSourceMaterial(separatedSourceInput.sourceText),
    [separatedSourceInput.sourceText]
  );
  const normalizedSourceText = separatedSourceInput.sourceText;
  const hasRewriteSource = Boolean(normalizedSourceText.trim() || separatedSourceInput.supportDocLinks);
  const effectiveMode: Draft["mode"] = hasRewriteSource ? "rewrite" : "topic";
  const normalizedPrompt = useMemo(() => normalizeRewritePrompt(effectiveMode, prompt, sourceText), [effectiveMode, prompt, sourceText]);
  const hasTaskInput = Boolean(normalizedPrompt.trim() || hasRewriteSource);
  const noticeIsError = notice.includes("失败") || notice.includes("未配置");

  const handleRevisionCompleted = useCallback(() => {
    setRevisionScope("full");
    setSelectedDraftText("");
  }, []);

  const {
    captureEditingState,
    canGenerate,
    canRevise,
    canStopGenerate,
    activeVariantKey,
    clearDraftResult,
    copyLast,
    generatedVariants,
    generateStage,
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
    lastDraftVersion,
    lastResearch,
    loadDraftResult,
    loadDraftVersion,
    selectGeneratedVariant
  } = useWriterGeneration({
    activeJobs,
    activeTitle,
    cancelTask,
    busy,
    hasTaskInput,
    mode: effectiveMode,
    normalizedPrompt,
    normalizedSourceText,
    originalSourceInput: sourceText,
    supportDocLinks: separatedSourceInput.supportDocLinks,
    recentJobs,
    revisionInstruction,
    revisionScope,
    revisionMode,
    selectedText: selectedDraftText,
    onDraftSaved: handleDraftSaved,
    onRevisionCompleted: handleRevisionCompleted,
    refresh,
    routerPush: router.push,
    routerReplace: router.replace,
    selectedAccount,
    styleRefs: selectedStyleRefs,
    setBusy,
    setNotice,
    startTask,
    useWebResearch
  });

  useEffect(() => {
    if (lastDraftId) loadedDraftParamRef.current = lastDraftId;
  }, [lastDraftId]);

  const { feishuResult, handlePublishFeishu, setFeishuResult } = useFeishuPublish({
    activeTitle,
    lastContent,
    setBusy,
    setNotice
  });
  const displayResearch = lastResearch;
  const [revisionTargets, setRevisionTargets] = useState<string[] | null>(null);
  const selectedRevisionKeys = revisionTargets === null ? [activeVariantKey] : revisionTargets.filter(key => generatedVariants.some(item => item.key === key));
  const submitRevision = () => handleRevise(revisionTargets === null ? undefined : selectedRevisionKeys);
  const canSubmitRevision = canRevise && selectedRevisionKeys.length > 0;
  const currentVersions = historyDrafts.filter(item => (item.version?.sessionId || item.id) === (lastDraftVersion?.sessionId || lastDraftId))
    .sort((a, b) => (b.version?.revision || 1) - (a.version?.revision || 1));
  const selectVersion = async (id: string) => {
    if (busy || id === lastDraftId) return;
    setBusy("load-version");
    try {
      const draft = await getDraft(id);
      loadDraftVersion(draft);
      loadedDraftParamRef.current = draft.id;
      router.replace(buildWriterDraftHref(draft), { scroll: false });
      setRevisionScope("full");
      setSelectedDraftText("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取稿件版本失败，请重试。");
    } finally { setBusy(""); }
  };
  const draftCharacterCount = lastContent.replace(/\s/g, "").length;
  const longDraftDisplay = draftCharacterCount > LONG_DRAFT_DISPLAY_THRESHOLD;
  const formattedDraftContent = useMemo(() => formatLongDraftForDisplay(lastContent), [lastContent]);

  useEffect(() => {
    setResearchOpen(false);
  }, [lastDraftId]);

  useEffect(() => {
    setDraftEditing(false);
  }, [activeVariantKey, lastDraftId]);

  const sourceFiles = useMemo(() => splitWriterSourceItems(sourceText).filter((item) => item.kind === "file"), [sourceText]);
  const sourceFileCount = sourceFiles.length;
  const sourceEditorText = useMemo(() => {
    let text = sourceText;
    for (const file of [...sourceFiles].reverse()) {
      const start = text.slice(0, file.start).endsWith("\n\n") ? file.start - 2 : file.start;
      text = text.slice(0, start) + text.slice(file.end);
    }
    return text;
  }, [sourceText, sourceFiles]);
  const nonFileTextMaterialCount = Math.max(0, sourceExtraction.textMaterialCount - sourceFileCount);
  const sourceItemCount = sourceExtraction.materials.length + separatedSourceInput.supportDocumentCount;
  const materialStatusLabel = sourceItemCount
    ? `${sourceItemCount} 项资料`
    : normalizedPrompt.trim()
      ? "自由输入"
      : "待素材";

  const handleDraftSelection = useCallback((field: HTMLTextAreaElement) => {
    if (revisionTargets !== null) return;
    const nextSelection = field.value.slice(field.selectionStart, field.selectionEnd);
    setSelectedDraftText(nextSelection);
    setRevisionScope(nextSelection.trim() ? "selection" : "full");
  }, [revisionTargets]);

  const handleClearDraftSelection = useCallback(() => {
    const field = draftEditorRef.current;
    if (field) {
      const caret = field.selectionEnd;
      field.focus();
      field.setSelectionRange(caret, caret);
    }
    setSelectedDraftText("");
    setRevisionScope("full");
  }, []);

  const handleSelectGeneratedVariant = useCallback((variantKey: string) => {
    selectGeneratedVariant(variantKey);
    setRevisionScope("full");
    setSelectedDraftText("");
  }, [selectGeneratedVariant]);

  const handleStartNewTask = useCallback(() => {
    if (busy || sourceImporting) return;
    if ((hasTaskInput || lastContent || hasAnyUnsavedChanges) && !window.confirm("新建任务会清空当前输入；已经保存的版本仍会保留。继续吗？")) {
      return;
    }

    loadedDraftParamRef.current = "";
    appliedSearchParamRef.current = "";
    clearDraftResult();
    setPrompt("");
    setSourceText("");
    setUseWebResearch(false);
    setRevisionInstruction("");
    setRevisionScope("full");
    setSelectedDraftText("");
    setHistoryOpen(false);

    const params = createWriterReferenceParams(selectedStyleRefs, "topic");
    router.replace(`/writer?${params.toString()}`, { scroll: false });
  }, [busy, clearDraftResult, hasAnyUnsavedChanges, hasTaskInput, lastContent, router, selectedStyleRefs, sourceImporting]);

  const handleSourceFiles = useCallback(async (files: File[]) => {
    if (!files.length || sourceImporting) return;
    setSourceImporting(true);
    try {
      const result = await uploadWriterSourceFiles(files);
      setSourceText((current) => appendWriterSourceFiles(current, result.files));
      const truncatedCount = result.files.filter((file) => file.truncated).length;
      notify({
        tone: "success",
        message: `已导入 ${result.files.length} 个文件${truncatedCount ? `，其中 ${truncatedCount} 个过长文件已截取` : ""}。`
      });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "导入素材文件失败" });
    } finally {
      setSourceImporting(false);
      setSourceDragActive(false);
      sourceDragDepthRef.current = 0;
      if (sourceFileInputRef.current) sourceFileInputRef.current.value = "";
    }
  }, [notify, sourceImporting]);

  const handleSourceDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (sourceImporting || !event.dataTransfer.types.includes("Files")) return;
    sourceDragDepthRef.current += 1;
    setSourceDragActive(true);
  }, [sourceImporting]);

  const handleSourceDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    sourceDragDepthRef.current = Math.max(0, sourceDragDepthRef.current - 1);
    if (!sourceDragDepthRef.current) setSourceDragActive(false);
  }, []);

  const handleSourceDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    sourceDragDepthRef.current = 0;
    setSourceDragActive(false);
    if (sourceImporting) return;
    void handleSourceFiles(Array.from(event.dataTransfer.files));
  }, [handleSourceFiles, sourceImporting]);

  useEffect(() => {
    if (!notice || isTaskProgressMessage(notice)) return;
    const usedRelay = /中转|兜底|备用模型/i.test(notice);
    notify({ tone: noticeIsError ? "error" : usedRelay ? "warning" : "success", message: notice });
  }, [notice, noticeIsError, notify]);

  const [undoHistorySwitch, setUndoHistorySwitch] = useState<(() => void) | null>(null);

  const applyLoadedDraft = useCallback((draft: Draft, batch?: Draft[]) => {
    setRevisionTargets(null);
    setStyleRefs(draftWriteStyleReferenceInputs(draft).filter(reference => reference.targetType === "account"));
    setPrompt(draft.prompt);
    setSourceText(restoreWriterSourceInput({
      originalSourceInput: draft.originalSourceInput,
      sourceText: draft.input,
      supportDocLinks: draft.supportDocLinks
    }));
    setUseWebResearch(Boolean(draft.sourceDigest?.webResearchEnabled) && webResearchAvailable);
    setRevisionScope("full");
    setSelectedDraftText("");
    loadDraftResult(draft, batch);
  }, [loadDraftResult, webResearchAvailable]);

  useEffect(() => {
    let ignore = false;
    const searchKey = searchParams.toString();
    const target = searchParams.get("targetType");
    const nextMode = searchParams.get("mode");
    const nextPrompt = searchParams.get("prompt");
    const nextSourceText = searchParams.get("sourceText");
    const nextAccountId = searchParams.get("accountId");
    const nextStyleRefs = searchParams.getAll("styleRef").flatMap((value) => {
      const reference = parseWriteStyleReferenceKey(value);
      return reference?.targetType === "account" ? [reference] : [];
    });
    const draftId = searchParams.get("draftId");

    if (draftId) {
      if (loadedDraftParamRef.current === draftId || loadedDraftParamRef.current === `loading:${draftId}`) return;
      loadedDraftParamRef.current = `loading:${draftId}`;
      getWriterHistoryDraft(draftId)
        .then(({ draft, batch }) => {
          if (ignore) return;
          loadedDraftParamRef.current = draft.id;
          applyLoadedDraft(draft, batch);
          if (draft.targetType === "project") setNotice("项目写作已移除，历史稿件可查看和手动保存。");
        })
        .catch((error) => {
          if (ignore) return;
          loadedDraftParamRef.current = "";
          setNotice(error instanceof Error ? error.message : "读取草稿详情失败");
        });
      return () => {
        ignore = true;
        // 释放本次请求的标记，允许依赖变化或 Strict Mode 清理后重新加载。
        if (loadedDraftParamRef.current === `loading:${draftId}`) {
          loadedDraftParamRef.current = "";
        }
      };
    }
    if (!draftId) loadedDraftParamRef.current = "";
    if (appliedSearchParamRef.current === searchKey) return;

    const hasUrlState =
      Boolean(target || nextMode || nextAccountId || nextStyleRefs.length) ||
      nextPrompt !== null ||
      nextSourceText !== null;
    if (!hasUrlState) {
      appliedSearchParamRef.current = searchKey;
      return;
    }

    if (nextStyleRefs.length) {
      setStyleRefs(nextStyleRefs);

    } else if (nextAccountId) {
      const platform = nextAccountId.split(":")[0];
      if (platform === "bilibili" || platform === "douyin") {
        setStyleRefs([{ targetType: "account", platform, accountId: nextAccountId }]);
      }
    }
    if (nextPrompt !== null) setPrompt(nextPrompt);
    if (nextSourceText !== null) setSourceText(nextSourceText);
    setUseWebResearch(false);
    setRevisionInstruction("");
    setRevisionScope("full");
    setSelectedDraftText("");
    appliedSearchParamRef.current = searchKey;
  }, [applyLoadedDraft, searchParams]);

  const clearHistoryCurrent = useCallback(() => {
    loadedDraftParamRef.current = "";
    clearDraftResult();
    setPrompt("");
    setSourceText("");
    setUseWebResearch(false);
    setRevisionInstruction("");
    setRevisionScope("full");
    setSelectedDraftText("");
    const params = createWriterReferenceParams(selectedStyleRefs, effectiveMode);
    router.replace(`/writer?${params.toString()}`, { scroll: false });
  }, [clearDraftResult, effectiveMode, router, selectedStyleRefs]);
  const { handleSelectHistoryDraft, handleDeleteHistoryDraft, handleDeleteHistoryDrafts, handleRenameHistoryDraft } = useWriterHistoryActions({
    historyDrafts, setDraftSummaries, lastDraftId, loadedDraftParamRef, applyLoadedDraft,
    onClearCurrent: clearHistoryCurrent, setNotice, refresh
  });

  if (!loading && !historyLoading && !library?.accounts.length && !historyDrafts.length && !searchParams.get("draftId")) {
    return (
      <div className="page writer-page">
        <header className="page-header">
          <div className="page-title-group">
            <span className="page-title-eyebrow">创作台</span>
            <div className="page-title-row">
              <span className="page-title-mark" aria-hidden="true">
                <PenLine size={20} strokeWidth={2.1} />
              </span>
              <div className="page-title-copy">
                <h1>对话写作</h1>
                <p className="subtle">需要至少一个账号风格作为引用。</p>
              </div>
            </div>
          </div>
        </header>
        <EmptyState title="还没有可参考的风格" body="先采集一个账号并生成风格卡，再来这里生成文案。" action={{ href: "/library", label: "去采集账号" }} />
      </div>
    );
  }

  return (
    <div
      className="page writer-page writer-page-full"
      data-unsaved-changes={hasAnyUnsavedChanges || hasTaskInput || Boolean(revisionInstruction.trim()) ? "true" : undefined}
    >
      <h1 className="sr-only">对话写作</h1>

      <section className="writer-workbench">
        <section className="panel writer-main">
          <div className="writer-content-grid">
            <div className="writer-task" id="writer-task-panel">
              <div className="section-title-row writer-setup-toolbar">
                <h2>写作设定</h2>
                <div className="writer-session-tools" role="group" aria-label="稿件管理">
                  <button className="btn ghost" disabled={Boolean(busy) || sourceImporting} onClick={() => { setHistorySessionId(""); setHistoryOpen(true); }} type="button" aria-haspopup="dialog">
                    <History aria-hidden="true" size={16} />历史
                  </button>
                  <button className="btn" disabled={Boolean(busy) || sourceImporting} onClick={handleStartNewTask} type="button">
                    <Plus aria-hidden="true" size={16} />新建
                  </button>
                </div>
              </div>

              <div className="writer-refbar">
                <div className="writer-reference-control">
                  <span>参考风格</span>
                  <WriterReferencePicker
                    accounts={library?.accounts || EMPTY_ACCOUNTS}
                    disabled={loading}
                    onChange={setStyleRefs}
                    references={selectedStyleRefs}
                  />
                </div>

                  <button
                    aria-label={styleCards.length > 1 ? `查看${activeTitle}` : `查看${activeTitle || "当前参考"}风格卡`}
                    className="btn ghost icon-only writer-style-trigger"
                    aria-busy={activeStyleLoading}
                    disabled={!styleCards.length}
                    onClick={() => setStyleOpen(true)}
                    title="查看风格卡"
                    type="button"
                  >
                    <Eye aria-hidden="true" size={16} />
                  </button>
              </div>
              {activeStyleError ? <p className="error" role="alert">风格卡读取失败，请点击眼睛查看详情。</p> : null}

              <WriterPromptField prompt={prompt} onChange={setPrompt} />

              <section className="writer-source-section">
                <div id="writer-source-content" className="writer-source-content">
                  <div className="writer-field writer-source-field">
                    <div className="writer-source-label-row">
                      <label htmlFor="writer-source-text">素材与原文</label>
                      <button
                        aria-busy={sourceImporting}
                        className="btn small ghost writer-source-file-button"
                        disabled={sourceImporting}
                        onClick={() => sourceFileInputRef.current?.click()}
                        title="支持 TXT、Markdown、CSV、JSON、HTML、字幕、DOCX 和 PDF"
                        type="button"
                      >
                        <Paperclip aria-hidden="true" size={14} />
                        {sourceImporting ? "导入中" : "添加文件"}
                      </button>
                      <input
                        accept={WRITER_SOURCE_FILE_ACCEPT}
                        aria-label="选择素材文件"
                        className="writer-source-file-input"
                        disabled={sourceImporting}
                        multiple
                        onChange={(event) => void handleSourceFiles(Array.from(event.target.files || []))}
                        ref={sourceFileInputRef}
                        type="file"
                      />
                    </div>
                    <div
                      className={`writer-source-dropzone ${sourceDragActive ? "drag-active" : ""}`}
                      onDragEnter={handleSourceDragEnter}
                      onDragLeave={handleSourceDragLeave}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                      }}
                      onDrop={handleSourceDrop}
                    >
                      <textarea
                        aria-label="素材、原文、视频链接或支持文档"
                        autoComplete="off"
                        className="writer-textarea source"
                        id="writer-source-text"
                        name="sourceText"
                        placeholder="粘贴原文或视频、文档链接，也可拖入文件。多条素材换行即可。"
                        value={sourceEditorText}
                        onChange={(event) => {
                          const text = event.target.value;
                          setSourceText((current) => {
                            const files = splitWriterSourceItems(current).filter((item) => item.kind === "file");
                            return [text, ...files.map((file) => file.raw)].filter(Boolean).join("\n\n");
                          });
                        }}
                      />
                      {sourceDragActive ? (
                        <div className="writer-source-drop-overlay" aria-hidden="true">
                          <Paperclip size={20} />
                          <strong>松开即可导入</strong>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {sourceFiles.length ? (
                    <div className="writer-attachments" aria-label="参考附件" aria-live="polite">
                      {sourceFiles.map((file, index) => (
                        <div className="source-detect-row" key={`${index}:${file.title}`}>
                          <FileText size={14} aria-hidden="true" />
                          <span>{file.title}</span>
                          <small>{file.content.length.toLocaleString()} 字</small>
                          <button
                            className="btn small ghost icon-only"
                            type="button"
                            aria-label={`移除附件 ${file.title}`}
                            disabled={Boolean(busy) || sourceImporting}
                            onClick={() => setSourceText((current) => {
                              const target = splitWriterSourceItems(current).filter((item) => item.kind === "file")[index];
                              return target ? current.slice(0, target.start) + current.slice(target.end) : current;
                            })}
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {sourceText.trim() ? (
                    <div className="source-detect-row" aria-live="polite">
                      {sourceFileCount ? <span className="status-pill done">{sourceFileCount} 个本地文件</span> : null}
                      {separatedSourceInput.supportDocumentCount ? <span className="status-pill done">{separatedSourceInput.supportDocumentCount} 份支持文档</span> : null}
                      {sourceExtraction.pendingLinkCount ? <span className="status-pill pending">{sourceExtraction.pendingLinkCount} 个视频链接待转写</span> : null}
                      {sourceExtraction.reusedTextLinkCount ? <span className="status-pill done">{sourceExtraction.reusedTextLinkCount} 个链接复用已有文案</span> : null}
                      {nonFileTextMaterialCount ? <span className="status-pill">{nonFileTextMaterialCount} 条文案</span> : null}
                      {sourceExtraction.onlyLinkCount ? <span className="status-pill pending">{sourceExtraction.onlyLinkCount} 条仅链接</span> : null}
                    </div>
                  ) : null}

                </div>
              </section>
              {lastDraftId ? (
                <section className="writer-preference-section" key={lastDraftId} aria-label="长期写作偏好">
                  <WriterPreference draftId={lastDraftId} disabled={Boolean(busy) || lastDraftBase?.targetType === "project"} onSaved={refresh} />
                </section>
              ) : null}

              <div className="writer-actionbar">
                {sessionDraftHydrated && hasTaskInput ? <span className="writer-autosave-status" role="status" title="输入已暂存"><CheckCircle2 aria-hidden="true" size={13} /><span className="sr-only">输入已暂存</span></span> : null}
                <div className="writer-action-controls">
                  <button
                    aria-label={useWebResearch ? "关闭联网补充资料" : "开启联网补充资料"}
                    aria-pressed={useWebResearch}
                    className={`btn icon-toggle writer-web-toggle ${useWebResearch ? "active" : ""}`}
                    disabled={!webResearchAvailable}
                    onClick={() => setUseWebResearch((enabled) => !enabled)}
                    title={webResearchCapability
                      ? webResearchCapability.available
                        ? `联网补充资料${webResearchCapability.model ? ` · ${webResearchCapability.model}` : ""}`
                        : webResearchCapability.reason
                      : "正在检查联网能力"}
                    type="button"
                  >
                    <Globe2 aria-hidden="true" size={16} />
                    {useWebResearch ? "已联网" : webResearchAvailable ? "联网" : "联网不可用"}
                  </button>
                  <button
                    className="btn primary writer-generate-button"
                    disabled={!canGenerate}
                    onClick={() => void handleGenerate()}
                    title={canGenerate
                      ? selectedStyleRefs.length > 1 ? `并发生成 ${selectedStyleRefs.length} 篇独立文案` : "生成文案"
                      : "先填写素材或写作要求"}
                    type="button"
                  >
                    <span>{busy === "generate"
                      ? "生成中"
                      : selectedStyleRefs.length > 1 ? `生成 ${selectedStyleRefs.length} 篇` : lastContent ? "重新生成" : "生成文案"}</span>
                    <span className="writer-submit-arrow" aria-hidden="true"><ArrowUpRight size={17} /></span>
                  </button>
                  {canStopGenerate ? (
                    <button className="btn ghost" onClick={() => void handleStopGenerate()} type="button">
                      <CircleStop aria-hidden="true" size={16} />
                      停止
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="writer-result" id="writer-result">
              <div className="section-title-row writer-document-toolbar">
                <div className="writer-result-title">
                  <h2>当前稿件</h2>
                  {lastDraftId ? <WriterActionMenu label="选择稿件版本" text={`V${lastDraftVersion?.revision || 1}`} icon={<ChevronDown size={12} aria-hidden="true" />} disabled={Boolean(busy)}>
                    {currentVersions.map(version => <button key={version.id} type="button" aria-current={version.id === lastDraftId ? "true" : undefined} onClick={() => void selectVersion(version.id)}>
                      <span className="writer-version-option"><strong>V{version.version?.revision || 1}{version.id === lastDraftId ? " · 当前" : ""}</strong><small>{version.version?.instruction || "初稿"}</small></span>
                    </button>)}
                  </WriterActionMenu> : null}
                  {lastContent ? <span className="writer-document-count" title="不含空白字符">{draftCharacterCount.toLocaleString()} 字</span> : null}
                  {hasUnsavedChanges ? <span className="status-pill pending">未保存</span> : null}
                </div>
                <div className="writer-result-actions">
                  {undoHistorySwitch ? <button className="btn ghost compact" type="button" disabled={Boolean(busy)} onClick={undoHistorySwitch}>撤回切换</button> : null}
                  {lastContent ? (
                    <>
                    <div className="writer-document-tools" role="group" aria-label="稿件操作">
                    {longDraftDisplay ? <button className="btn ghost compact" type="button" onClick={() => setDraftEditing((editing) => !editing)}>
                      <PenLine aria-hidden="true" size={15} />
                      {draftEditing ? "查看排版" : "编辑原文"}
                    </button> : null}
                    <button className="btn ghost icon-only writer-tool" aria-label="复制稿件" title="复制稿件" onClick={copyLast} type="button">
                      <Copy aria-hidden="true" size={16} />
                    </button>
                    {hasUnsavedChanges ? <button
                      aria-busy={busy === "save-draft"}
                      className="btn ghost compact"
                      disabled={!hasUnsavedChanges || Boolean(busy)}
                      onClick={() => void handleSaveEdit()}
                      type="button"
                    >
                      <Save aria-hidden="true" size={16} />
                      {busy === "save-draft" ? "保存中" : "保存版本"}
                    </button> : null}
                    <WriterActionMenu label="更多稿件操作" icon={<MoreHorizontal aria-hidden="true" size={17} />}>
                        {displayResearch ? <button onClick={() => setResearchOpen(true)} type="button"><BookOpenText size={16} aria-hidden="true" />{displayResearch.includes("成稿检查（需修改）") ? "参考资料 · 待检查" : "参考资料"}</button> : null}
                        <button disabled={Boolean(busy)} onClick={handlePublishFeishu} type="button">
                          <FileUp aria-hidden="true" size={16} />
                          {busy === "feishu" ? "发布中…" : "发布到飞书"}
                        </button>
                        <button disabled={!lastDraftBase || Boolean(busy)} onClick={handleOpenAssets} type="button">
                          <MessageSquarePlus aria-hidden="true" size={16} />
                          {busy === "assets" ? "准备中" : "生成评论 / 弹幕"}
                        </button>
                    </WriterActionMenu>
                    </div>
                    </>
                  ) : (
                    <span className="status-pill pending" data-busy={busy === "generate" ? "true" : undefined}>{busy === "generate" ? "生成中" : "待输入"}</span>
                  )}
                </div>
              </div>
              {busy === "generate" ? (
                <div className="writer-generation-status" role="status" aria-live="polite">
                  <span className="writer-activity-dot" aria-hidden="true" />
                  <div>
                    <strong>{generateStage || "正在生成文案"}</strong>
                    <span>任务会在后台继续，可以留在当前页面等待。</span>
                  </div>
                </div>
              ) : null}
              {generatedVariants.length > 1 ? (
                <div aria-label="并发生成的独立稿件" className="writer-variant-tabs" role="tablist">
                  {generatedVariants.map((variant, index) => (
                    <button
                      aria-selected={variant.key === activeVariantKey}
                      className={variant.key === activeVariantKey ? "active" : ""}
                      key={variant.key}
                      disabled={Boolean(busy)}
                      onClick={() => handleSelectGeneratedVariant(variant.key)}
                      role="tab"
                      type="button"
                    >
                      <span>{variant.title || `风格 ${index + 1}`}</span>
                      <small>
                        {variant.hasUnsavedChanges ? "未保存" : `V${variant.version?.revision || 1}`}
                      </small>
                    </button>
                  ))}
                </div>
              ) : null}
              {lastContent && (!longDraftDisplay || draftEditing || busy === "generate") ? (
                <textarea
                  aria-label="当前稿件"
                  className="result-box writer-draft-editor"
                  onChange={(event) => {
                    setDraftEditing(true);
                    handleContentChange(event.target.value);
                    setSelectedDraftText("");
                    setRevisionScope("full");
                  }}
                  onKeyUp={(event) => handleDraftSelection(event.currentTarget)}
                  onMouseUp={(event) => handleDraftSelection(event.currentTarget)}
                  readOnly={busy === "generate"}
                  ref={draftEditorRef}
                  spellCheck={false}
                  value={lastContent}
                />
              ) : lastContent ? (
                <div aria-label="当前稿件（排版预览）" className="result-box writer-draft-preview" tabIndex={0}>
                  {formattedDraftContent}
                </div>
              ) : (
                <div className="writer-result-empty">
                  <span aria-hidden="true"><Sparkles size={20} /></span>
                  <strong>{busy === "generate" ? "正在准备第一版" : "暂无稿件"}</strong>
                  <p>{busy === "generate" ? "正在整理素材、风格和写作要求。" : `${activeTitle || "当前参考"} · ${materialStatusLabel}`}</p>
                </div>
              )}
              {lastContent ? (
                <section className="writer-revision-composer" aria-labelledby="writer-revision-title">
                  <div className="writer-revision-head">
                    <div>
                      <h3 id="writer-revision-title">继续修改 <span>基于 V{lastDraftVersion?.revision || 1}</span></h3>
                    </div>
                    {selectedDraftText ? (
                      <button className="writer-selection-chip" onClick={handleClearDraftSelection} type="button">
                        只改选中 {selectedDraftText.length} 字
                        <X aria-hidden="true" size={13} />
                      </button>
                    ) : null}
                  </div>
                  <label className="writer-field">
                    <span className="sr-only">本轮修改要求</span>
                    <textarea
                      aria-label="本轮修改要求"
                      aria-describedby="writer-revision-mode-help"
                      ref={revisionInputRef}
                      rows={2}
                      className="writer-textarea revision"
                      disabled={busy === "generate"}
                      onChange={(event) => setRevisionInstruction(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmitRevision) {
                          event.preventDefault();
                          void submitRevision();
                        }
                      }}
                      placeholder="例如：压缩第 2 段，产品参数和原有表达方式保持不变。"
                      value={revisionInstruction}
                    />
                  </label>
                  <div className="writer-revision-actions">
                    <div className="writer-revision-options">
                    {generatedVariants.length > 1 ? <WriterActionMenu label="选择要修改的稿件" text={revisionTargets === null ? "当前稿件" : `已选 ${selectedRevisionKeys.length} 篇`} icon={<ChevronDown size={12} aria-hidden="true" />} disabled={Boolean(busy)}>
                      <label className="writer-revision-choice"><input type="checkbox" checked={selectedRevisionKeys.length === generatedVariants.length} onChange={event => { setRevisionTargets(event.target.checked ? generatedVariants.map(item => item.key) : []); setRevisionScope("full"); setSelectedDraftText(""); }} />全选稿件</label>
                      {generatedVariants.map(item => <label className="writer-revision-choice" key={item.key}><input type="checkbox" checked={selectedRevisionKeys.includes(item.key)} onChange={event => { setRevisionTargets(event.target.checked ? [...selectedRevisionKeys, item.key] : selectedRevisionKeys.filter(key => key !== item.key)); setRevisionScope("full"); setSelectedDraftText(""); }} />{item.title}</label>)}
                      <button type="button" onClick={() => setRevisionTargets(null)}>仅当前稿件</button>
                    </WriterActionMenu> : null}
                    <label className="writer-revision-mode">
                      <span className="sr-only">修改方式</span>
                      <WorkbenchSelect className="writer-ref-select" aria-label="修改方式" aria-describedby="writer-revision-mode-help" disabled={busy === "generate"} value={revisionMode}
                        onValueChange={(value) => setRevisionMode(value as "edit" | "recalibrate")}>
                        <option value="edit">按要求微调</option>
                        <option value="recalibrate">重新校准风格</option>
                      </WorkbenchSelect>
                    </label>
                    <WriterActionMenu label="快捷修改要求" icon={<Sparkles size={16} aria-hidden="true" />}>
                      {[
                        ["精简篇幅", "精简篇幅，保留核心信息和原有表达风格。"],
                        ["加强开头", "加强开头的吸引力，其余内容尽量保持不变。"]
                      ].map(([label, instruction]) => (
                        <button className="btn small ghost" disabled={Boolean(busy)} key={label} type="button" onClick={() => {
                          setRevisionInstruction((current) => current.trim() ? `${current.trim()}\n${instruction}` : instruction);
                          revisionInputRef.current?.focus();
                        }}>{label}</button>
                      ))}
                    </WriterActionMenu>
                    </div>
                    <button
                      aria-busy={busy === "generate"}
                      className="btn primary writer-revise-submit"
                      title="⌘ / Ctrl + Enter"
                      disabled={!canSubmitRevision}
                      onClick={() => void submitRevision()}
                      type="button"
                    >
                      <Send aria-hidden="true" size={16} />
                      {busy === "generate" ? "生成中" : selectedRevisionKeys.length > 1 ? `修改 ${selectedRevisionKeys.length} 篇` : "修改"}
                    </button>
                  </div>
                  <p className="writer-revision-help" id="writer-revision-mode-help">
                    {lastDraftBase?.targetType === "project" ? "项目写作已移除，旧稿可手动编辑保存；新建账号稿请点击「新建」。" : revisionTargets !== null ? `将要求分别应用于所选 ${selectedRevisionKeys.length} 篇全文，保留各自风格并新增版本。` : selectedDraftText ? "仅修改选中内容，生成完整新版本。" : revisionMode === "recalibrate" ? "沿用本稿参考，重新组织表达。" : "选中文字可局部修改；其余表达尽量保留。"}
                  </p>
                </section>
              ) : null}
            </div>
          </div>
        </section>

        {historyOpen ? <WriterHistoryPanel
          drafts={historyDrafts}
          loading={historyLoading}
          initialSessionId={historySessionId}
          onClose={closeHistory}
          onDeleteDraft={handleDeleteHistoryDraft}
          onDeleteDrafts={handleDeleteHistoryDrafts}
          onRenameDraft={handleRenameHistoryDraft}
          selectedDraftId={lastDraftId}
          onSelectDraft={async (draft) => {
            if (busy) return false;
            const restoreOutput = captureEditingState();
            const previousUrl = `/writer?${searchParams.toString()}`;
            await handleSelectHistoryDraft(draft);
            setUndoHistorySwitch(() => () => {
              restoreOutput();
              setStyleRefs(styleRefs);
              setPrompt(prompt);
              setSourceText(sourceText);
              setUseWebResearch(useWebResearch);
              setRevisionInstruction(revisionInstruction);
              setRevisionMode(revisionMode);
              setRevisionScope(revisionScope);
              setSelectedDraftText(selectedDraftText);
              loadedDraftParamRef.current = lastDraftId;
              appliedSearchParamRef.current = previousUrl.split("?")[1] || "";
              router.replace(previousUrl, { scroll: false });
              setUndoHistorySwitch(null);
            });
            return true;
          }}
        /> : null}
      </section>

      {researchOpen && displayResearch ? (
        <WriterDialogModal labelledBy="writer-reference-dialog-title" onClose={() => setResearchOpen(false)} panelClassName="writer-reference-dialog">
          <div className="modal-header">
            <div><h2 id="writer-reference-dialog-title">本稿参考资料</h2><p className="subtle">生成当前稿件时使用的写法、原文与资料</p></div>
            <button className="btn ghost icon-only" aria-label="关闭参考资料" onClick={() => setResearchOpen(false)} type="button"><X aria-hidden="true" size={18} /></button>
          </div>
          <ResearchReferenceBody text={displayResearch} />
        </WriterDialogModal>
      ) : null}

      {styleOpen ? (
        <WriterStyleModal activeTitle={activeTitle} onClose={() => setStyleOpen(false)} styleCards={styleCards} />
      ) : null}

      {feishuResult ? (
        <FeishuResultModal result={feishuResult} onClose={() => setFeishuResult(null)} />
      ) : null}
    </div>
  );
}

function ResearchReferenceBody({ id, text }: { id?: string; text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"'）)]+)/g);
  return (
    <pre className="style-reference-body" id={id}>
      {parts.map((part, index) =>
        /^https?:\/\//i.test(part) ? (
          <a href={part} key={`${part}-${index}`} rel="noreferrer" target="_blank">
            {part}
          </a>
        ) : part
      )}
    </pre>
  );
}

function createWriterReferenceParams(references: WriteStyleReferenceInput[], mode: Draft["mode"]) {
  const primary = references[0];
  const params = new URLSearchParams({
    targetType: primary?.targetType || "account",
    mode
  });
  if (primary?.targetType === "account") params.set("accountId", primary.accountId);
  for (const reference of references) params.append("styleRef", writeStyleReferenceKey(reference));
  return params;
}

function WriterFallback() {
  return (
    <div className="page writer-page">
      <header className="page-header">
        <div className="page-title-group">
          <span className="page-title-eyebrow">创作台</span>
          <div className="page-title-row">
            <span className="page-title-mark" aria-hidden="true">
              <PenLine size={20} strokeWidth={2.1} />
            </span>
            <div className="page-title-copy">
              <h1>对话写作</h1>
              <p className="subtle">正在读取写作台引用和历史记录。</p>
            </div>
          </div>
        </div>
      </header>
      <section className="panel">
        <div className="panel-inner">
          <p className="subtle">正在准备写作台…</p>
        </div>
      </section>
    </div>
  );
}
