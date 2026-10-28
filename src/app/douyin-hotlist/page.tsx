"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import { Suspense, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Flame,
  RefreshCw,
  SlidersHorizontal,
  TrendingUp
} from "lucide-react";
import {
  addDouyinHotlistAccount,
  deleteDouyinHotlistGroup,
  getCachedDouyinHotlist,
  getDouyinHotlist,
  getDouyinHotlistRefreshLogs,
  removeDouyinHotlistAccount
} from "@/lib/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useFeedback } from "@/components/FeedbackProvider";
import { useScopedTasks } from "@/components/TaskProvider";
import type {
  DouyinHotlistAccount,
  DouyinHotlistResponse,
  JobRecord,
  Platform
} from "@/lib/types";
import {
  buildHotlistHref,
  getPlatformAccountSelection,
  getPlatformLabel,
  getHotlistGroupAccounts,
  getSelectedAccount,
  getSelectionPlatform,
  getVisibleHotlistItems,
  getWindowLabel,
  isRefreshBusyMessage,
  isTerminalRefreshJob,
  parseSortMode,
  parseWindowFilter,
  sortOptions,
  type AccountSelection,
  type BusyState,
  type RefreshLogEntry,
  type SortMode,
  type WindowFilter
} from "./_lib/douyin-hotlist-model";
import { AccountManagementDrawer } from "./_components/AccountManagementDrawer";
import { AccountFilter, PlatformFilterControl, WindowFilterControl } from "./_components/HotlistFilters";
import { EmptyHotlist, HotlistLoadingRows, HotlistTable } from "./_components/HotlistTable";
import { HotlistGroupEditor } from "./_components/HotlistGroupEditor";
import { HotlistGroupFilter } from "./_components/HotlistGroupFilter";
import { RefreshLogMenu } from "./_components/RefreshLogMenu";

const REFRESH_LIMIT = 10;
const HOTLIST_AUTO_REFRESH_CHECK_MS = 5 * 60_000;

export default function DouyinHotlistPage() {
  return (
    <Suspense fallback={<DouyinHotlistFallback />}>
      <DouyinHotlistPageContent />
    </Suspense>
  );
}

function DouyinHotlistPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tasks = useScopedTasks({ href: "/douyin-hotlist", kinds: ["hotlist-refresh"] });
  const { startTask, loading: tasksLoading } = tasks;
  const { notify } = useFeedback();
  const initialWindowFilter = parseWindowFilter(searchParams.get("window"));
  const [snapshot, setSnapshot] = useState<DouyinHotlistResponse | null>(() => getCachedDouyinHotlist({ window: initialWindowFilter }));
  const [query, setQuery] = useState("");
  const [accountPlatform, setAccountPlatform] = useState<Platform>("douyin");
  const selectedAccountId: AccountSelection = searchParams.get("account") || "all";
  const selectedGroupId = searchParams.get("group") || "all";
  const [groupEditor, setGroupEditor] = useState<string | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<{ id: string; name: string; revision: number } | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const deleteGroupBusyRef = useRef(false);
  const [deleteGroupError, setDeleteGroupError] = useState("");
  const groupAccounts = useMemo(() => getHotlistGroupAccounts(snapshot?.accounts ?? [], snapshot?.groups ?? [], selectedGroupId), [snapshot?.accounts, snapshot?.groups, selectedGroupId]);
  const groupAccountIds = useMemo(() => new Set(groupAccounts.map((account) => account.id)), [groupAccounts]);
  const selectedGroup = snapshot?.groups?.find((group) => group.id === selectedGroupId);
  const sortMode = parseSortMode(searchParams.get("sort"));
  const windowFilter = parseWindowFilter(searchParams.get("window"));
  const setSelection = useCallback((values: { account?: AccountSelection; group?: string; sort?: SortMode; window?: WindowFilter }) => {
    router.replace(buildHotlistHref({
      account: values.account ?? selectedAccountId, group: values.group ?? selectedGroupId, sort: values.sort ?? sortMode,
      window: values.window ?? windowFilter, pathname, search: searchParams.toString()
    }), { scroll: false });
  }, [pathname, router, searchParams, selectedAccountId, selectedGroupId, sortMode, windowFilter]);
  const setSelectedAccountId = useCallback((account: AccountSelection) => setSelection({ account }), [setSelection]);
  const setSortMode = (sort: SortMode) => setSelection({ sort });
  const setWindowFilter = (window: WindowFilter) => setSelection({ window });
  const [busy, setBusy] = useState<BusyState>(() => getCachedDouyinHotlist({ window: initialWindowFilter }) ? "" : "load");
  const [error, setError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<DouyinHotlistAccount | null>(null);
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false);
  const [refreshLogs, setRefreshLogs] = useState<RefreshLogEntry[]>([]);
  const [refreshLogsLoading, setRefreshLogsLoading] = useState(true);
  const [refreshLogsError, setRefreshLogsError] = useState("");
  const busyRef = useRef<BusyState>(busy);
  const activeRefreshJobRef = useRef<JobRecord | null>(null);
  const syncedRefreshDataRevisionsRef = useRef<Map<string, number>>(new Map());
  const syncedTerminalRefreshJobRef = useRef<string | null>(null);
  const loadRequestIdRef = useRef(0);
  const refreshLogRequestIdRef = useRef(0);
  const activeRefreshJob = tasks.activeJobs[0] || null;
  const latestTerminalRefreshJob = tasks.jobs.find(isTerminalRefreshJob) || null;
  const latestTerminalRefreshJobId = latestTerminalRefreshJob?.id || "";
  const latestTerminalRefreshJobStatus = latestTerminalRefreshJob?.status || "";
  const latestTerminalRefreshJobUpdatedAt = latestTerminalRefreshJob?.updatedAt || "";
  const latestTerminalRefreshDataRevision = latestTerminalRefreshJob?.dataRevision || 0;
  const latestTerminalRefreshSignature = latestTerminalRefreshJobId
    ? `${latestTerminalRefreshJobId}:${latestTerminalRefreshJobUpdatedAt}:${latestTerminalRefreshDataRevision}`
    : "";
  const [startingRefresh, setStartingRefresh] = useState(false);
  const startingRefreshRef = useRef(false);
  const automaticAttemptAtRef = useRef(0);
  const refreshing = Boolean(activeRefreshJob) || startingRefresh;

  const loadRefreshLogs = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    const requestId = refreshLogRequestIdRef.current + 1;
    refreshLogRequestIdRef.current = requestId;
    setRefreshLogsLoading(true);
    try {
      const result = await getDouyinHotlistRefreshLogs({ signal: options.signal });
      if (refreshLogRequestIdRef.current !== requestId) return;
      setRefreshLogs(result.logs);
      setRefreshLogsError("");
    } catch (error) {
      if (options.signal?.aborted || refreshLogRequestIdRef.current !== requestId) return;
      setRefreshLogsError(error instanceof Error ? error.message : "读取共享刷新日志失败");
    } finally {
      if (refreshLogRequestIdRef.current === requestId) setRefreshLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadRefreshLogs({ signal: controller.signal });
    return () => controller.abort();
  }, [loadRefreshLogs]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    activeRefreshJobRef.current = activeRefreshJob;
  }, [activeRefreshJob]);

  const loadHotlist = useCallback(async (options: { force?: boolean } = {}) => {
    const requestId = ++loadRequestIdRef.current;
    const cached = options.force ? null : getCachedDouyinHotlist({ window: windowFilter });
    if (cached) {
      setSnapshot(cached);
      busyRef.current = "";
      setBusy("");
      setError("");
      return cached;
    }

    busyRef.current = "load";
    setBusy("load");
    setError("");
    try {
      const next = await getDouyinHotlist({ force: options.force, window: windowFilter });
      if (loadRequestIdRef.current === requestId) setSnapshot(next);
      return next;
    } catch (err) {
      if (loadRequestIdRef.current === requestId) {
        setError(err instanceof Error ? err.message : "读取视频热榜失败");
      }
      return null;
    } finally {
      if (loadRequestIdRef.current === requestId) {
        busyRef.current = "";
        setBusy("");
      }
    }
  }, [windowFilter]);

  useEffect(() => {
    void loadHotlist();
  }, [loadHotlist]);

  useEffect(() => {
    if (!activeRefreshJob || activeRefreshJob.dataChange?.resource !== "douyin-hotlist") return;
    const dataRevision = activeRefreshJob.dataRevision || 0;
    if (dataRevision <= (syncedRefreshDataRevisionsRef.current.get(activeRefreshJob.id) || 0)) return;
    syncedRefreshDataRevisionsRef.current.set(activeRefreshJob.id, dataRevision);
    void loadHotlist({ force: true });
  }, [activeRefreshJob, loadHotlist]);

  useEffect(() => {
    if (!snapshot || snapshot.summary.windowKey !== windowFilter || selectedAccountId === "all") return;
    if (selectedGroupId !== "all" && !selectedGroup) return;
    if (getSelectionPlatform(selectedAccountId)) return;
    if (groupAccounts.some((account) => account.id === selectedAccountId)) return;
    setSelectedAccountId("all");
  }, [groupAccounts, selectedAccountId, selectedGroup, selectedGroupId, setSelectedAccountId, snapshot, windowFilter]);

  const selectedPlatform = useMemo(() => getSelectionPlatform(selectedAccountId), [selectedAccountId]);


  const selectedAccount = useMemo(
    () => getSelectedAccount(snapshot ? { ...snapshot, accounts: groupAccounts } : null, selectedAccountId, selectedPlatform),
    [groupAccounts, selectedAccountId, selectedPlatform, snapshot]
  );

  const selectedPlatformAccounts = useMemo(() => {
    if (!snapshot || !selectedPlatform) return [];
    return groupAccounts.filter((account) => account.platform === selectedPlatform);
  }, [groupAccounts, selectedPlatform, snapshot]);

  const visibleItems = useMemo(
    () => getVisibleHotlistItems({
      items: (snapshot?.items || []).filter((item) => groupAccountIds.has(item.account.id)),
      selectedAccountId,
      selectedPlatform,
      sortMode
    }),
    [groupAccountIds, selectedAccountId, selectedPlatform, snapshot?.items, sortMode]
  );

  const summary = snapshot?.summary;
  const operationBusy = Boolean(busy) || refreshing || deletingGroup;
  const canAdd = Boolean(query.trim()) && !operationBusy;
  const canRefresh = Boolean(selectedPlatform ? selectedPlatformAccounts.length : groupAccounts.length) &&
    !operationBusy;
  const initialLoading = busy === "load" && !snapshot;
  const windowLabel = getWindowLabel(summary?.windowKey || windowFilter);
  const selectedPlatformLabel = selectedPlatform ? getPlatformLabel(selectedPlatform) : "";
  const refreshLabel = selectedAccount ? "抓取当前账号" : selectedPlatform ? `抓取${selectedPlatformLabel}${windowLabel}` : `抓取全部${windowLabel}`;
  const rankTitle = selectedAccount ? selectedAccount.name : selectedPlatform ? `${selectedPlatformLabel}热度榜` : selectedGroup?.name || "实时热度榜";
  const activePlatformFilter: Platform | "all" = selectedPlatform || selectedAccount?.platform || "all";
  const visibleAccountCount = selectedAccount ? 1 : selectedPlatform ? selectedPlatformAccounts.length : groupAccounts.length;
  const rankSubtitle = summary ? <>
    <span><strong className="hotlist-summary-count">{visibleAccountCount}</strong> 个{selectedPlatformLabel}账号</span>
    <span>{windowLabel} <strong className="hotlist-summary-count">{visibleItems.length}</strong> 条</span>
    {initialLoading || refreshing ? <span className="status-pill pending">{initialLoading ? "读取中" : `刷新 ${Math.round(activeRefreshJob?.progress || 0)}%`}</span> : null}
  </> : "正在读取视频热榜…";

  async function handleDeleteGroup() {
    if (!deleteGroupTarget || deleteGroupBusyRef.current) return;
    deleteGroupBusyRef.current = true;
    setDeletingGroup(true);
    setDeleteGroupError("");
    try {
      const next = await deleteDouyinHotlistGroup({ groupId: deleteGroupTarget.id, revision: deleteGroupTarget.revision, window: windowFilter });
      ++loadRequestIdRef.current;
      busyRef.current = "";
      setBusy("");
      setSnapshot(next);
      setDeleteGroupTarget(null);
      setSelection({ group: "all" });
      notify({ tone: "success", message: "分组已删除，监控账号和视频已保留。" });
    } catch (error) {
      setDeleteGroupError(error instanceof Error ? error.message : "删除分组失败，请重试。");
    } finally {
      deleteGroupBusyRef.current = false;
      setDeletingGroup(false);
    }
  }

  async function handleAddAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdd) return;

    busyRef.current = "add";
    setBusy("add");
    setError("");
    try {
      const next = await addDouyinHotlistAccount({ platform: accountPlatform, query, window: windowFilter });
      setSnapshot(next);
      setQuery("");
      notify({ tone: "success", message: `已加入${getPlatformLabel(accountPlatform)}视频热榜账号池。` });
    } catch (err) {
      notify({ tone: "error", message: err instanceof Error ? err.message : `添加${getPlatformLabel(accountPlatform)}账号失败` });
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  }

  const refreshHotlist = useCallback(async (automatic = false) => {
    if (!snapshot?.accounts.length || tasksLoading || activeRefreshJobRef.current || busyRef.current || startingRefreshRef.current) return;
    if (!automatic && !groupAccounts.length) return;
    startingRefreshRef.current = true;
    setStartingRefresh(true);
    if (automatic) automaticAttemptAtRef.current = Date.now();

    setError("");
    try {
      const job = await startTask({
        kind: "hotlist-refresh",
        href: "/douyin-hotlist",
        input: {
          accountIds: automatic ? undefined : selectedAccount
            ? [selectedAccount.id]
            : selectedPlatform
              ? selectedPlatformAccounts.map((account) => account.id)
              : selectedGroupId !== "all" ? groupAccounts.map((account) => account.id) : undefined,
          automatic,
          limit: REFRESH_LIMIT,
          window: automatic ? "3d" : windowFilter
        }
      });
      activeRefreshJobRef.current = job;
      notify({ tone: "info", message: "刷新任务已开始，可在任务中心查看进度或停止。" });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "未知错误";
      const refreshBusy = isRefreshBusyMessage(errorMessage);
      if (refreshBusy) {
        notify({ tone: "warning", message: errorMessage });
      } else {
        notify({ tone: "error", message: errorMessage });
      }
    } finally {
      startingRefreshRef.current = false;
      setStartingRefresh(false);
    }
  }, [groupAccounts, notify, selectedAccount, selectedGroupId, selectedPlatform, selectedPlatformAccounts, snapshot?.accounts.length, startTask, tasksLoading, windowFilter]);

  useEffect(() => {
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const current = await loadHotlist();
      if (!current?.accounts.length || document.visibilityState !== "visible") return;
      const lastCheck = Math.max(
        Date.parse(current.summary.lastFullRefreshAttemptAt || current.summary.lastFullRefreshAt || "") || 0,
        automaticAttemptAtRef.current
      );
      if (Date.now() - lastCheck >= 3 * 60 * 60 * 1000) void refreshHotlist(true);
    };
    void check();
    // 自动抓取阈值是 3 小时，5 分钟检查一次足够；其他设备的刷新会经任务中心同步。
    const timer = window.setInterval(check, HOTLIST_AUTO_REFRESH_CHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [loadHotlist, refreshHotlist, snapshot?.summary.lastFullRefreshAttemptAt, snapshot?.summary.lastFullRefreshAt]);

  useEffect(() => {
    if (tasks.loading) return;
    if (syncedTerminalRefreshJobRef.current === null) {
      syncedTerminalRefreshJobRef.current = latestTerminalRefreshSignature;
      return;
    }
    if (!latestTerminalRefreshSignature) return;

    if (syncedTerminalRefreshJobRef.current === latestTerminalRefreshSignature) return;
    syncedTerminalRefreshJobRef.current = latestTerminalRefreshSignature;
    void loadRefreshLogs();
    if (latestTerminalRefreshJobStatus === "completed" || latestTerminalRefreshDataRevision > 0) {
      void loadHotlist({ force: true });
    }
  }, [
    latestTerminalRefreshDataRevision,
    latestTerminalRefreshJobStatus,
    latestTerminalRefreshSignature,
    loadHotlist,
    loadRefreshLogs,
    tasks.loading
  ]);

  async function handleRefresh() {
    if (!canRefresh) return;
    await refreshHotlist();
  }

  async function handleRemoveAccount(accountId: string) {
    busyRef.current = `remove:${accountId}`;
    setBusy(`remove:${accountId}`);
    setError("");
    try {
      setSnapshot(await removeDouyinHotlistAccount(accountId, { window: windowFilter }));
      setRemoveTarget(null);
      if (selectedAccountId === accountId) {
        setSelectedAccountId("all");
      }
      notify({ tone: "success", message: "已从热榜账号池移除。" });
    } catch (err) {
      notify({ tone: "error", message: err instanceof Error ? err.message : "移除视频热榜账号失败" });
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  }

  return (
    <div className="page douyin-hotlist-page workbench-frame-page">
      <header className="page-header">
        <div className="page-title-group">
          <span className="page-title-eyebrow">对标内容</span>
          <div className="page-title-row">
            <span className="page-title-mark" aria-hidden="true">
              <Flame size={20} strokeWidth={2.1} />
            </span>
            <div className="page-title-copy">
              <h1>视频热榜</h1>
              <p className="subtle">维护抖音 / B站独立对标池，抓取{windowLabel}值得拆解的内容。</p>
            </div>
          </div>
        </div>
        <div className="page-header-meta">
          <button className="btn" onClick={() => setAccountDrawerOpen(true)} type="button">
            <SlidersHorizontal aria-hidden="true" size={16} />
            管理账号
          </button>
          <RefreshLogMenu error={refreshLogsError} loading={refreshLogsLoading} logs={refreshLogs} />
          <button className="btn" aria-busy={busy === "load"} disabled={operationBusy} onClick={() => void loadHotlist({ force: true })} type="button">
            <RefreshCw aria-hidden="true" size={16} />
            重载
          </button>
          <button className="btn primary" aria-busy={refreshing} disabled={!canRefresh} onClick={() => void handleRefresh()} type="button">
            <TrendingUp aria-hidden="true" size={16} />
            {activeRefreshJob ? `抓取中 ${Math.round(activeRefreshJob.progress)}%` : refreshLabel}
          </button>
        </div>
      </header>

      {error ? <div className="error" role="alert">{error}</div> : null}

      <section className="douyin-hotlist-workspace workbench-frame-workspace">
        <section className="pane douyin-hotlist-rank-pane">
          <HotlistGroupFilter
            groups={snapshot?.groups ?? []} selectedId={selectedGroupId} accountCount={snapshot?.accounts.length ?? 0}
            disabled={operationBusy || !snapshot}
            onSelect={(group) => setSelection({ group, account: "all" })}
            onAdd={() => setGroupEditor("new")}
            onEdit={() => setGroupEditor(selectedGroupId)}
            onDelete={() => {
              if (!selectedGroup) return;
              setDeleteGroupError("");
              setDeleteGroupTarget({ id: selectedGroup.id, name: selectedGroup.name, revision: snapshot?.groupRevision ?? 0 });
            }}
          />
          {snapshot && selectedGroupId !== "all" && !selectedGroup ? <p className="error" role="alert">该分组不存在，请选择“全部”或重新加载。</p> : null}
          <div className="pane-header">
            <div>
              <h2>{rankTitle}</h2>
              <p className="pane-subtitle hotlist-summary" aria-live="polite">{rankSubtitle}</p>
            </div>
            <div className="douyin-hotlist-rank-actions">
              <WindowFilterControl
                disabled={operationBusy}
                onChange={setWindowFilter}
                value={windowFilter}
              />
              <PlatformFilterControl
                disabled={operationBusy || initialLoading || !groupAccounts.length}
                onChange={(platform) => setSelectedAccountId(platform === "all" ? "all" : getPlatformAccountSelection(platform))}
                value={activePlatformFilter}
              />
              <AccountFilter
                accounts={groupAccounts}
                disabled={operationBusy || initialLoading || !groupAccounts.length}
                onChange={setSelectedAccountId}
                value={selectedAccountId}
              />
              <label className="inline-sort-control douyin-hotlist-sort">
                <span>排序</span>
                <WorkbenchSelect
                  aria-label="榜单排序"
                  disabled={operationBusy}
                  onValueChange={(value) => setSortMode(value as SortMode)}
                  value={sortMode}
                >
                  {sortOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </WorkbenchSelect>
              </label>
            </div>
          </div>

          {initialLoading ? (
            <HotlistLoadingRows />
          ) : visibleItems.length ? (
            <HotlistTable items={visibleItems} showGlobalRank={Boolean(selectedAccount)} />
          ) : selectedGroup && !groupAccounts.length ? (
            <div className="hotlist-group-empty"><h3>这个分组还没有账号</h3><p className="subtle">添加监控账号后，这里会集中显示它们的视频。</p><button className="btn" type="button" onClick={() => setGroupEditor(selectedGroup.id)}>选择分组账号</button></div>
          ) : (
            <EmptyHotlist hasAccounts={Boolean(snapshot?.accounts.length)} selectedAccount={selectedAccount?.name} windowLabel={windowLabel} />
          )}
        </section>
      </section>
      {deleteGroupTarget ? <ConfirmDialog
        title="删除这个分组？"
        body={<><p>将删除“{deleteGroupTarget.name}”分组，监控账号、视频和其他分组都会保留。</p>{deleteGroupError ? <p className="error" role="alert">{deleteGroupError}</p> : null}</>}
        confirmLabel="删除分组"
        busy={deletingGroup}
        onCancel={() => { if (!deleteGroupBusyRef.current) setDeleteGroupTarget(null); }}
        onConfirm={() => void handleDeleteGroup()}
      /> : null}
      {groupEditor && snapshot ? <HotlistGroupEditor
        group={snapshot.groups?.find((group) => group.id === groupEditor)} snapshot={snapshot} windowFilter={windowFilter}
        onClose={() => setGroupEditor(null)}
        onSaved={(next, groupId) => {
          ++loadRequestIdRef.current;
          busyRef.current = "";
          setBusy("");
          setSnapshot(next);
          setGroupEditor(null);
          setSelection({ group: groupId, account: "all" });
          notify({ tone: "success", message: "分组已保存。" });
        }}
      /> : null}
      {accountDrawerOpen ? (
        <AccountManagementDrawer
          accounts={snapshot?.accounts || []}
          accountPlatform={accountPlatform}
          busy={busy}
          canAdd={canAdd}
          disabled={operationBusy}
          initialLoading={initialLoading}
          query={query}
          selectedAccountId={selectedAccountId}
          summary={snapshot?.summary}
          windowLabel={windowLabel}
          onAddAccount={handleAddAccount}
          onClose={() => setAccountDrawerOpen(false)}
          onPlatformChange={setAccountPlatform}
          onQueryChange={setQuery}
          onRemoveAccount={setRemoveTarget}
          onSelectAccount={(account) => setSelection({ account, group: "all" })}
        />
      ) : null}
      {removeTarget ? (
        <ConfirmDialog
          body={`会将“${removeTarget.name}”从视频热榜账号池移除，本地热榜记录也会随账号池更新。`}
          busy={busy === `remove:${removeTarget.id}`}
          confirmLabel="移除账号"
          title="移除热榜账号？"
          onCancel={() => {
            if (busy !== `remove:${removeTarget.id}`) setRemoveTarget(null);
          }}
          onConfirm={() => void handleRemoveAccount(removeTarget.id)}
        />
      ) : null}
    </div>
  );
}

function DouyinHotlistFallback() {
  return (
    <div className="page douyin-hotlist-page workbench-frame-page">
      <section className="douyin-hotlist-workspace workbench-frame-workspace">
        <section className="pane douyin-hotlist-rank-pane">
          <HotlistLoadingRows />
        </section>
      </section>
    </div>
  );
}
