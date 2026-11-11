"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, FileText, RefreshCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { updateLibraryUrl } from "./_components/library-url";
import { AccountSidebar } from "./_components/AccountSidebar";
import { AccountStyleEditorModal } from "./_components/AccountStyleEditorModal";
import { LibraryDetailPane } from "./_components/LibraryDetailPane";
import { LibraryQuickStartPanel } from "./_components/LibraryQuickStartPanel";
import { TranscriptEditorModal } from "./_components/TranscriptEditorModal";
import { VideoTable } from "./_components/VideoTable";
import { collectOrderOptions, formatTimeRangeLabel, getDateFilter, normalizeCollectOrder, type TimeRange } from "./_components/library-collect-utils";
import { makePreview } from "./_components/library-view-utils";
import { useVideoStatsHydration } from "./_hooks/useBilibiliStatsHydration";
import { useLibraryAccountDetail } from "./_hooks/useLibraryAccountDetail";
import { useLibraryMutations } from "./_hooks/useLibraryMutations";
import { useLibraryAccountSelection, useLibraryVideoSelection } from "./_hooks/useLibrarySelection";
import { useLibraryTaskActions } from "./_hooks/useLibraryTaskActions";
import { useLibraryTaskEffects } from "./_hooks/useLibraryTaskEffects";
import { useLibraryTranscriptActions } from "./_hooks/useLibraryTranscriptActions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { useFeedback, type FeedbackTone } from "@/components/FeedbackProvider";
import { useLibrary } from "@/components/LibraryProvider";
import { useScopedTasks } from "@/components/TaskProvider";
import { exportAccountTranscripts } from "@/lib/client";
import { isTaskProgressMessage } from "@/lib/feedback-messages";
import type { AccountListItem, CollectOrder, CollectResult, Platform, VideoListItem } from "@/lib/types";

type ConfirmIntent =
  | { kind: "accounts"; ids: string[]; accounts: AccountListItem[]; projectNames: string[] }
  | { kind: "videos"; platform: Platform; accountId: string; accountName: string; videos: VideoListItem[]; deletingActiveVideo: boolean }
  | { kind: "retranscribe"; accountName: string; video: VideoListItem };

export default function LibraryPage() {
  return (
    <Suspense fallback={<LibraryPageFallback />}>
      <LibraryPageContent />
    </Suspense>
  );
}

function LibraryPageContent() {
  const searchParams = useSearchParams();
  const mobileView = searchParams.get("mv") === "detail"
    ? "detail"
    : searchParams.get("mv") === "videos"
      ? "videos"
      : "accounts";
  const { library, loading, error, refresh } = useLibrary();
  const { activeJobs, recentJobs, startTask } = useScopedTasks({
    href: "/library",
    kinds: ["account-style", "transcribe-video", "batch-transcribe", "collect-account"]
  });
  const { notify } = useFeedback();
  const [styleDraft, setStyleDraft] = useState("");
  const [styleLoading, setStyleLoading] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone: FeedbackTone } | null>(null);
  const setMessage = useCallback((message: string, tone: FeedbackTone = "info") => {
    setNotice(message ? { message, tone } : null);
  }, []);
  const [openModal, setOpenModal] = useState<"" | "transcript" | "style">("");
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent | null>(null);
  const [collectPlatform, setCollectPlatform] = useState<Platform>("bilibili");
  const [collectName, setCollectName] = useState("");
  const [collectLimit, setCollectLimit] = useState(20);
  const [collectOrder, setCollectOrder] = useState<CollectOrder>("views");
  const [collectTimeRange, setCollectTimeRange] = useState<TimeRange>("all");
  const [customFromDate, setCustomFromDate] = useState("");
  const [customToDate, setCustomToDate] = useState("");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [collectPanelOpen, setCollectPanelOpen] = useState(false);
  const [lastCollect, setLastCollect] = useState<CollectResult | null>(null);
  const [activeCollectJobId, setActiveCollectJobId] = useState("");
  const setMobileView = useCallback((view: "accounts" | "videos" | "detail") => {
    updateLibraryUrl({ mv: view === "accounts" ? null : view });
  }, []);

  const accounts = useMemo(() => library?.accounts || [], [library?.accounts]);
  const initialLibraryLoading = loading && !library;
  const {
    accountFilter,
    accountManageMode,
    filteredAccounts,
    selectedAccountIds,
    selectedAccountMeta,
    clearAccountFilters,
    selectAccount,
    setAccountFilter,
    setAccountManageMode,
    setSelectedAccountIds,
    toggleAccountManage,
    toggleManagedAccount
  } = useLibraryAccountSelection(accounts);

  const {
    accountDetail,
    accountDetailError,
    accountDetailLoading,
    reloadSelectedAccountDetail,
    selectedAccountDetailId,
    selectedAccountDetailPlatform,
    setAccountDetail
  } = useLibraryAccountDetail({ selectedAccountMeta });
  const selectedAccount = accountDetail?.id === selectedAccountMeta?.id ? accountDetail : null;

  const {
    changeSortMode,
    effectiveSortMode,
    failedCount,
    maxPrimaryMetric,
    pendingCount,
    selectVideo,
    selectedVideo,
    selectedVideoIds,
    selectedVideoOpenUrl,
    setSelectedVideoIds,
    setVideoFilter,
    setVideoManageMode,
    setVideoStatusFilter,
    sortDirection,
    sortedVideos,
    toggleVideoManage,
    videoFilter,
    videoManageMode,
    videoStatusFilter
  } = useLibraryVideoSelection(selectedAccount);

  const openTranscriptEditor = useCallback(() => setOpenModal("transcript"), []);
  const closeDeleteDialog = useCallback(() => setConfirmIntent(null), []);
  const closeEditorModal = useCallback(() => setOpenModal(""), []);
  const requestDeleteAccounts = useCallback(() => {
    const selected = accounts.filter((account) => selectedAccountIds.includes(account.id));
    if (!selected.length) return;
    const selectedIds = new Set(selected.map((account) => account.id));
    const projectNames = (library?.projects || [])
      .filter((project) => project.sourceAccountIds.some((accountId) => selectedIds.has(accountId)))
      .map((project) => project.name);
    setConfirmIntent({ kind: "accounts", ids: selected.map((account) => account.id), accounts: selected, projectNames });
  }, [accounts, library?.projects, selectedAccountIds]);
  const requestDeleteVideos = useCallback(() => {
    if (!selectedAccount) return;
    const videos = selectedAccount.videos.filter((video) => selectedVideoIds.includes(video.id));
    if (!videos.length) return;
    setConfirmIntent({
      kind: "videos",
      platform: selectedAccount.platform,
      accountId: selectedAccount.id,
      accountName: selectedAccount.name,
      videos,
      deletingActiveVideo: Boolean(selectedVideo && videos.some((video) => video.id === selectedVideo.id))
    });
  }, [selectedAccount, selectedVideo, selectedVideoIds]);

  const {
    activeTranscript,
    clearTranscript,
    handleRestoreTranscript,
    handleSaveTranscript,
    invalidateTranscript,
    openTranscriptModal,
    selectedVideoHasTranscript,
    transcriptLoading,
    transcriptError,
    transcriptRestoring,
    transcriptPreview,
    transcriptVersions,
    updateTranscriptDraft
  } = useLibraryTranscriptActions({
    refresh,
    reloadSelectedAccountDetail,
    selectedAccount,
    selectedVideo,
    setMessage,
    onOpenEditor: openTranscriptEditor,
    onSaved: closeEditorModal
  });

  const {
    busy,
    setActiveBatchJobId,
    setActiveStyleJobId,
    setActiveTranscribeJobId,
    setBusy,
    setStyleProgress,
    setStyleStage,
    setTranscribeProgress,
    setTranscribeStage,
    styleProgress,
    styleStage,
    transcribeProgress,
    transcribeStage
  } = useLibraryTaskEffects({
    activeJobs,
    recentJobs,
    reloadSelectedAccountDetail,
    selectedAccount,
    selectedVideo,
    invalidateTranscript,
    setAccountDetail,
    setMessage,
    setStyleDraft
  });

  const { handleBatchTranscribe, handleGenerateStyle, handleTranscribe } = useLibraryTaskActions({
    refresh,
    reloadSelectedAccountDetail,
    selectedAccount,
    selectedVideo,
    setActiveBatchJobId,
    setActiveStyleJobId,
    setActiveTranscribeJobId,
    setBusy,
    setMessage,
    setStyleProgress,
    setStyleStage,
    setTranscribeProgress,
    setTranscribeStage,
    startTask
  });

  const {
    handleDeleteSelectedAccounts,
    handleDeleteSelectedVideos,
    handleSaveStyle
  } = useLibraryMutations({
    clearTranscript,
    closeDeleteDialog,
    refresh,
    reloadSelectedAccountDetail,
    selectedAccount,
    setAccountDetail,
    setAccountManageMode,
    setBusy,
    setMessage,
    setSelectedAccountIds,
    setSelectedVideoIds,
    setVideoManageMode,
    styleDraft
  });

  const selectedVideoIdForTable = selectedVideo?.id || "";
  const styleLoaded = Boolean(selectedAccount?.style?.trim() && selectedAccountMeta?.styleStatus !== "not_generated");
  const stylePreview = useMemo(() => makePreview(styleLoaded ? selectedAccount?.style || "" : "", true), [selectedAccount?.style, styleLoaded]);
  const visibleMessage = notice?.message && notice.message !== error ? notice.message : "";
  const collectDateFilter = useMemo(() => getDateFilter(collectTimeRange, customFromDate, customToDate), [
    collectTimeRange,
    customFromDate,
    customToDate
  ]);
  const activeTimeLabel = formatTimeRangeLabel(collectTimeRange, collectDateFilter.fromDate, collectDateFilter.toDate);
  const activeOrderOptions = collectOrderOptions[collectPlatform];
  const canCollect = Boolean(collectName.trim()) && !busy;

  useVideoStatsHydration({ refresh, reloadSelectedAccountDetail, selectedAccount });

  useEffect(() => {
    if (!visibleMessage || isTaskProgressMessage(visibleMessage)) return;
    notify({
      tone: notice?.tone || "info",
      message: visibleMessage,
      action: lastCollect && visibleMessage.startsWith("采集完成") && notice?.tone !== "error" ? { label: "整理账号", href: "/library" } : undefined
    });
  }, [lastCollect, notice?.tone, notify, visibleMessage]);

  useEffect(() => {
    if (!selectedAccount) return;
    if (openModal === "style" && styleDraft !== (selectedAccount.style || "")) return;
    setStyleDraft(typeof selectedAccount.style === "string" ? selectedAccount.style : "");
  }, [openModal, selectedAccount, styleDraft]);

  const openStyleModal = useCallback(async () => {
    if (!selectedAccountDetailId || !selectedAccountDetailPlatform) return;
    if (typeof selectedAccount?.style === "string") {
      setStyleDraft(selectedAccount.style);
      setOpenModal("style");
      return;
    }

    setStyleLoading(true);
    setMessage("");
    try {
      const detail = await reloadSelectedAccountDetail({ includeStyle: true });
      if (!detail) return;
      setStyleDraft(detail.style || "");
      setOpenModal("style");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "读取账号风格卡失败", "error");
    } finally {
      setStyleLoading(false);
    }
  }, [
    reloadSelectedAccountDetail,
    selectedAccount?.style,
    selectedAccountDetailId,
    selectedAccountDetailPlatform,
    setMessage
  ]);

  const saveTranscriptDraft = useCallback(() => {
    void handleSaveTranscript(setBusy);
  }, [handleSaveTranscript, setBusy]);

  const handleCollectPlatformChange = useCallback((nextPlatform: Platform) => {
    setCollectPlatform(nextPlatform);
    setCollectOrder((currentOrder) => normalizeCollectOrder(nextPlatform, currentOrder));
  }, []);

  const handleRefresh = useCallback(async () => {
    if (refreshBusy) return;
    setRefreshBusy(true);
    try {
      await refresh();
      if (selectedAccount) await reloadSelectedAccountDetail({ force: true });
      setMessage("账号库已刷新。", "success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "刷新账号库失败", "error");
    } finally {
      setRefreshBusy(false);
    }
  }, [refresh, refreshBusy, reloadSelectedAccountDetail, selectedAccount, setMessage]);

  const handleCollect = useCallback(async () => {
    if (!canCollect) return;
    setBusy("collect");
    setMessage("");
    setLastCollect(null);
    try {
      const job = await startTask({
        kind: "collect-account",
        href: "/library",
        title: `采集账号：${collectName.trim()}`,
        input: {
          platform: collectPlatform,
          name: collectName,
          limit: collectLimit,
          order: collectOrder,
          ...collectDateFilter
        }
      });
      setActiveCollectJobId(job.id);
      setCollectPanelOpen(false);
      setMessage("采集任务已加入任务中心，可离开页面继续处理。", "info");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "采集失败，请检查账号名、主页链接或 opencli 配置后重试。", "error");
      setBusy("");
    }
  }, [
    canCollect,
    collectDateFilter,
    collectLimit,
    collectName,
    collectOrder,
    collectPlatform,
    setBusy,
    setMessage,
    startTask
  ]);

  const handleExportTranscripts = useCallback(async (videoIds?: string[]) => {
    if (!selectedAccount) return;
    setBusy("export-transcripts");
    setMessage("");
    try {
      const result = await exportAccountTranscripts({
        platform: selectedAccount.platform,
        accountId: selectedAccount.id,
        videoIds
      });
      setMessage(`已导出 ${result.transcriptCount} 份转写稿：${result.fileName}`, "success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "导出转写稿失败", "error");
    } finally {
      setBusy("");
    }
  }, [selectedAccount, setBusy, setMessage]);

  useEffect(() => {
    if (!activeCollectJobId) return;
    const job = [...activeJobs, ...recentJobs].find((item) => item.id === activeCollectJobId);
    if (!job || job.status === "queued" || job.status === "running") return;

    setActiveCollectJobId("");
    setBusy("");
    if (job.status === "completed" && job.result) {
      const result = job.result as CollectResult;
      setLastCollect(result);
      setMessage(formatCollectMessage(result, activeTimeLabel, collectOrder), "success");
      void refresh()
        .then(() => reloadSelectedAccountDetail({ force: true }))
        .catch(() => undefined);
      return;
    }
    setMessage(job.error || job.message || "采集任务未完成。", "error");
  }, [activeCollectJobId, activeJobs, activeTimeLabel, collectOrder, recentJobs, refresh, reloadSelectedAccountDetail, setBusy, setMessage]);

  const handleToggleAllAccounts = useCallback(() => {
    const visibleIds = filteredAccounts.map((account) => account.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((accountId) => selectedAccountIds.includes(accountId));
    setSelectedAccountIds(allSelected ? [] : visibleIds);
  }, [filteredAccounts, selectedAccountIds, setSelectedAccountIds]);

  const handleToggleAllVideos = useCallback(() => {
    const visibleIds = sortedVideos.map((video) => video.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((videoId) => selectedVideoIds.includes(videoId));
    setSelectedVideoIds(allSelected ? [] : visibleIds);
  }, [selectedVideoIds, setSelectedVideoIds, sortedVideos]);

  const handleBatchTranscribeSelected = useCallback(() => {
    const pendingIds = sortedVideos
      .filter((video) => selectedVideoIds.includes(video.id) && video.transcriptStatus !== "completed")
      .map((video) => video.id);
    if (pendingIds.length) void handleBatchTranscribe({ videoIds: pendingIds });
  }, [handleBatchTranscribe, selectedVideoIds, sortedVideos]);

  const handleExportSelected = useCallback(() => {
    const completedIds = sortedVideos
      .filter((video) => selectedVideoIds.includes(video.id) && video.transcriptStatus === "completed")
      .map((video) => video.id);
    if (completedIds.length) void handleExportTranscripts(completedIds);
  }, [handleExportTranscripts, selectedVideoIds, sortedVideos]);

  const handleTranscribeRequest = useCallback(() => {
    if (!selectedAccount || !selectedVideo) return;
    if (selectedVideoHasTranscript) {
      setConfirmIntent({ kind: "retranscribe", accountName: selectedAccount.name, video: selectedVideo });
      return;
    }
    void handleTranscribe();
  }, [handleTranscribe, selectedAccount, selectedVideo, selectedVideoHasTranscript]);

  if (!loading && !library?.accounts.length) {
    return (
      <div className="page library-page workbench-frame-page">
        <header className="page-header">
          <div className="page-title-group">
            <span className="page-title-eyebrow">账号风格</span>
            <div className="page-title-row">
              <span className="page-title-mark" aria-hidden="true">
                <FileText size={20} strokeWidth={2.1} />
              </span>
              <div className="page-title-copy">
                <h1>账号库</h1>
                <p className="subtle">采集、转写、风格沉淀。</p>
              </div>
            </div>
          </div>
        </header>
        <LibraryQuickStartPanel
          activeOrderOptions={activeOrderOptions}
          busy={busy}
          canSubmit={canCollect}
          customFromDate={customFromDate}
          customToDate={customToDate}
          limit={collectLimit}
          name={collectName}
          order={collectOrder}
          platform={collectPlatform}
          timeRange={collectTimeRange}
          onCollect={handleCollect}
          onCustomFromDateChange={setCustomFromDate}
          onCustomToDateChange={setCustomToDate}
          onLimitChange={setCollectLimit}
          onNameChange={setCollectName}
          onOrderChange={setCollectOrder}
          onPlatformChange={handleCollectPlatformChange}
          onTimeRangeChange={setCollectTimeRange}
        />
        <EmptyState title="还没有账号" body="在上方添加 B站或抖音账号并采集，采集结果会自动写入本地风格库。" />
      </div>
    );
  }

  return (
    <div className={`page library-page workbench-frame-page mobile-library-${mobileView}`}>
      <header className="page-header">
        <div className="page-title-group">
          <span className="page-title-eyebrow">账号风格</span>
          <div className="page-title-row">
            <span className="page-title-mark" aria-hidden="true">
              <FileText size={20} strokeWidth={2.1} />
            </span>
            <div className="page-title-copy">
              <h1>账号库</h1>
              <p className="subtle">采集、转写、风格沉淀。</p>
            </div>
          </div>
        </div>
        <div className="page-header-meta">
          <button
            aria-busy={refreshBusy}
            aria-label={refreshBusy ? "正在刷新账号库" : "刷新账号库"}
            className="btn ghost compact icon-btn icon-only"
            disabled={refreshBusy}
            onClick={() => void handleRefresh()}
            title={refreshBusy ? "正在刷新账号库" : "刷新账号库"}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      <div className="mobile-library-nav" aria-label="账号库层级导航">
        {mobileView !== "accounts" ? (
          <button
            className="btn icon-btn"
            onClick={() => setMobileView(mobileView === "detail" ? "videos" : "accounts")}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={18} />
            返回
          </button>
        ) : <span />}
        <strong>
          {mobileView === "accounts"
            ? "选择账号"
            : mobileView === "videos"
              ? selectedAccountMeta?.name || "视频列表"
              : selectedVideo?.title || "视频详情"}
        </strong>
      </div>

      {error || accountDetailError ? (
        <div className="library-error-stack">
          {error ? <div className="error" role="alert">{error}</div> : null}
          {accountDetailError ? <div className="error" role="alert">{accountDetailError}</div> : null}
        </div>
      ) : null}
      <section className={`three-pane library-workspace workbench-frame-workspace mobile-view-${mobileView}`}>
        <AccountSidebar
          accountFilter={accountFilter}
          accountManageMode={accountManageMode}
          accounts={filteredAccounts}
          busy={busy}
          collectPanelOpen={collectPanelOpen}
          loading={initialLibraryLoading}
          selectedAccountId={selectedAccountMeta?.id || ""}
          selectedAccountIds={selectedAccountIds}
          onAccountFilterChange={setAccountFilter}
          onClearFilters={clearAccountFilters}
          onRequestDeleteAccounts={requestDeleteAccounts}
          onSelectAccount={(accountId) => {
            selectAccount(accountId, "videos");
          }}
          onToggleCollectPanel={() => {
            setAccountManageMode(false);
            setSelectedAccountIds([]);
            setVideoManageMode(false);
            setSelectedVideoIds([]);
            setCollectPanelOpen((current) => !current);
          }}
          onToggleAccountManage={() => {
            setCollectPanelOpen(false);
            setVideoManageMode(false);
            setSelectedVideoIds([]);
            toggleAccountManage();
          }}
          onToggleAllAccounts={handleToggleAllAccounts}
          onToggleManagedAccount={toggleManagedAccount}
        />
        {collectPanelOpen ? (
          <LibraryQuickStartPanel
            activeOrderOptions={activeOrderOptions}
            busy={busy}
            canSubmit={canCollect}
            customFromDate={customFromDate}
            customToDate={customToDate}
            limit={collectLimit}
            name={collectName}
            order={collectOrder}
            platform={collectPlatform}
            timeRange={collectTimeRange}
            variant="drawer"
            onClose={() => setCollectPanelOpen(false)}
            onCollect={handleCollect}
            onCustomFromDateChange={setCustomFromDate}
            onCustomToDateChange={setCustomToDate}
            onLimitChange={setCollectLimit}
            onNameChange={setCollectName}
            onOrderChange={setCollectOrder}
            onPlatformChange={handleCollectPlatformChange}
            onTimeRangeChange={setCollectTimeRange}
          />
        ) : null}

        <VideoTable
          accountDetailLoading={accountDetailLoading}
          busy={busy}
          effectiveSortMode={effectiveSortMode}
          failedCount={failedCount}
          loading={initialLibraryLoading}
          maxPrimaryMetric={maxPrimaryMetric}
          pendingCount={pendingCount}
          selectedAccount={selectedAccount}
          selectedAccountMeta={selectedAccountMeta}
          selectedVideoId={selectedVideoIdForTable}
          sortDirection={sortDirection}
          videoFilter={videoFilter}
          selectedVideoIds={selectedVideoIds}
          videos={sortedVideos}
          videoManageMode={videoManageMode}
          videoStatusFilter={videoStatusFilter}
          onBatchTranscribeSelected={handleBatchTranscribeSelected}
          onExportSelected={handleExportSelected}
          onRequestDeleteVideos={requestDeleteVideos}
          onSelectVideo={(videoId) => {
            selectVideo(videoId, "detail");
          }}
          onSortModeChange={changeSortMode}
          onToggleAllVideos={handleToggleAllVideos}
          onToggleVideoManage={() => {
            setAccountManageMode(false);
            setSelectedAccountIds([]);
            toggleVideoManage();
          }}
          onVideoFilterChange={setVideoFilter}
          onVideoStatusFilterChange={setVideoStatusFilter}
        />

        <LibraryDetailPane
          busy={busy}
          loading={initialLibraryLoading}
          selectedAccount={selectedAccount}
          selectedVideo={selectedVideo}
          selectedVideoHasTranscript={selectedVideoHasTranscript}
          selectedVideoOpenUrl={selectedVideoOpenUrl}
          stylePreview={stylePreview}
          styleLoaded={styleLoaded}
          styleLoading={styleLoading}
          styleProgress={styleProgress}
          transcriptError={transcriptError}
          transcriptLoading={transcriptLoading}
          transcriptPreview={transcriptPreview}
          transcribeProgress={transcribeProgress}
          transcribeStage={transcribeStage}
          onBatchTranscribe={() => void handleBatchTranscribe()}
          onExportTranscripts={handleExportTranscripts}
          onGenerateBatchStyle={() => void handleBatchTranscribe({ updateStyle: true })}
          onGenerateStyle={handleGenerateStyle}
          onOpenStyleModal={openStyleModal}
          onOpenTranscriptModal={openTranscriptModal}
          onTranscribe={handleTranscribeRequest}
        />
      </section>

      {openModal === "transcript" ? (
        <TranscriptEditorModal
          activeTranscript={activeTranscript}
          busy={busy}
          restoring={transcriptRestoring}
          versions={transcriptVersions}
          onChange={updateTranscriptDraft}
          onClose={closeEditorModal}
          onRestore={(versionId) => void handleRestoreTranscript(versionId)}
          onSave={saveTranscriptDraft}
        />
      ) : null}
      {openModal === "style" ? (
        <AccountStyleEditorModal
          busy={busy}
          styleDraft={styleDraft}
          unsavedChanges={Boolean(selectedAccount && styleDraft !== (selectedAccount.style || ""))}
          styleProgress={styleProgress}
          styleStage={styleStage}
          onChange={setStyleDraft}
          onClose={closeEditorModal}
          onGenerateStyle={handleGenerateStyle}
          onSaveStyle={handleSaveStyle}
        />
      ) : null}
      {confirmIntent?.kind === "accounts" ? (
        <ConfirmDialog
          body={<AccountDeleteImpact intent={confirmIntent} />}
          busy={busy === "account-delete"}
          confirmLabel={`删除 ${confirmIntent.ids.length} 个账号`}
          title="确认删除账号？"
          onCancel={closeDeleteDialog}
          onConfirm={() => void handleDeleteSelectedAccounts(confirmIntent.ids)}
        />
      ) : null}
      {confirmIntent?.kind === "videos" ? (
        <ConfirmDialog
          body={<VideoDeleteImpact intent={confirmIntent} />}
          busy={busy === "video-delete"}
          confirmLabel={`删除 ${confirmIntent.videos.length} 条视频`}
          title="确认删除视频？"
          onCancel={closeDeleteDialog}
          onConfirm={() => void handleDeleteSelectedVideos({
            platform: confirmIntent.platform,
            accountId: confirmIntent.accountId,
            videoIds: confirmIntent.videos.map((video) => video.id),
            deletingActiveVideo: confirmIntent.deletingActiveVideo
          })}
        />
      ) : null}
      {confirmIntent?.kind === "retranscribe" ? (
        <ConfirmDialog
          body={(
            <>
              <p>将重新转写「{confirmIntent.video.title}」。</p>
              <p>现有稿会先保存为历史版本，任务完成前发生的其他编辑不会被覆盖。</p>
            </>
          )}
          confirmLabel="重新转写"
          title="确认重新转写？"
          onCancel={closeDeleteDialog}
          onConfirm={() => {
            closeDeleteDialog();
            void handleTranscribe();
          }}
        />
      ) : null}
    </div>
  );
}

function LibraryPageFallback() {
  return (
    <div className="page library-page workbench-frame-page">
      <header className="page-header">
        <div className="page-title-group">
          <span className="page-title-eyebrow">账号风格</span>
          <div className="page-title-row">
            <span className="page-title-mark" aria-hidden="true">
              <FileText size={20} strokeWidth={2.1} />
            </span>
            <div className="page-title-copy">
              <h1>账号库</h1>
              <p className="subtle">正在读取本地风格库。</p>
            </div>
          </div>
        </div>
      </header>
    </div>
  );
}

function AccountDeleteImpact({ intent }: { intent: Extract<ConfirmIntent, { kind: "accounts" }> }) {
  const videoCount = intent.accounts.reduce((sum, account) => sum + account.videoCount, 0);
  const transcriptCount = intent.accounts.reduce((sum, account) => sum + account.transcriptCount, 0);
  const draftCount = intent.accounts.reduce((sum, account) => sum + account.draftCount, 0);
  return (
    <>
      <p>将永久删除：{summarizeNames(intent.accounts.map((account) => account.name))}。</p>
      <p>包含 {videoCount} 条视频、{transcriptCount} 份转写稿和 {draftCount} 份账号草稿。</p>
      {intent.projectNames.length ? <p>还会从 {intent.projectNames.length} 个项目移除引用：{summarizeNames(intent.projectNames)}。</p> : null}
      <p>此操作无法撤销。</p>
    </>
  );
}

function VideoDeleteImpact({ intent }: { intent: Extract<ConfirmIntent, { kind: "videos" }> }) {
  const transcriptCount = intent.videos.filter((video) => video.transcriptStatus === "completed").length;
  return (
    <>
      <p>将从「{intent.accountName}」永久删除：{summarizeNames(intent.videos.map((video) => video.title))}。</p>
      <p>同时删除其中 {transcriptCount} 份转写稿，并清理账号草稿里的视频引用。</p>
      <p>此操作无法撤销。</p>
    </>
  );
}

function summarizeNames(names: string[]) {
  const visible = names.slice(0, 3).map((name) => `「${name}」`).join("、");
  return names.length > 3 ? `${visible} 等 ${names.length} 项` : visible;
}

function formatCollectMessage(
  result: CollectResult,
  activeTimeLabel: string,
  order: CollectOrder
) {
  const base = `采集完成：opencli 返回 ${result.rawCount} 条，${activeTimeLabel}内写入 ${result.filteredCount} 条到「${result.account.name}」。`;
  const filter = result.dateFilter;
  if (!filter?.applied || result.filteredCount > 0 || result.rawCount === 0) return base;

  const dateRange =
    filter.earliestPublishedAt && filter.latestPublishedAt
      ? `本次返回视频发布时间为 ${filter.earliestPublishedAt} 至 ${filter.latestPublishedAt}`
      : filter.missingDateCount
        ? `本次返回的视频有 ${filter.missingDateCount} 条缺少发布时间`
        : "本次返回视频不在所选时间范围内";
  const orderHint = order === "pubdate" ? "" : "，或把排序改成「时间优先」";
  return `${base} ${dateRange}，都不在当前时间范围内；请把时间改成「不限」/更早的范围${orderHint}后再采集。`;
}
