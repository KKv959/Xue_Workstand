"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import { Suspense, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, Dialog, DialogTrigger, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import {
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
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
import { AccountFilter, WindowFilterControl } from "./_components/HotlistFilters";
import { EmptyHotlist, HotlistLoadingRows, HotlistTable, getHotlistItemKey } from "./_components/HotlistTable";
import { HotlistDetailDrawer } from "./_components/HotlistDetailDrawer";
import { InkHero } from "@/components/InkHero";
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

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [surgeOnly, setSurgeOnly] = useState(false);
  const surgeCount = useMemo(() => visibleItems.filter(({ item }) => item.surge).length, [visibleItems]);
  // 新进：24 小时内发布的条目。
  const freshCount = useMemo(() => visibleItems.filter(({ item }) => item.ageHours !== undefined && item.ageHours < 24).length, [visibleItems]);
  // “只看飙升”只筛显示，名次保留在全榜里的位置。
  const shownItems = useMemo(() => surgeOnly ? visibleItems.filter(({ item }) => item.surge) : visibleItems, [surgeOnly, visibleItems]);
  const selectedIndex = selectedKey ? shownItems.findIndex(({ item }) => getHotlistItemKey(item) === selectedKey) : -1;
  const selectedEntry = selectedIndex >= 0 ? shownItems[selectedIndex] : null;
  const closeDetail = useCallback(() => setSelectedKey(null), []);
  const stepDetail = useCallback((delta: number) => {
    const next = shownItems[Math.min(shownItems.length - 1, Math.max(0, selectedIndex + delta))];
    if (next) setSelectedKey(getHotlistItemKey(next.item));
  }, [selectedIndex, shownItems]);

  const summary = snapshot?.summary;
  const operationBusy = Boolean(busy) || refreshing || deletingGroup;
  const canAdd = Boolean(query.trim()) && !operationBusy;
  const canRefresh = Boolean(selectedPlatform ? selectedPlatformAccounts.length : groupAccounts.length) &&
    !operationBusy;
  const initialLoading = busy === "load" && !snapshot;
  const windowLabel = getWindowLabel(summary?.windowKey || windowFilter);
  const selectedPlatformLabel = selectedPlatform ? getPlatformLabel(selectedPlatform) : "";
  const refreshLabel = selectedAccount ? "抓取当前账号" : selectedPlatform ? `抓取${selectedPlatformLabel}${windowLabel}` : `抓取全部${windowLabel}`;
  const activePlatformFilter: Platform | "all" = selectedPlatform || selectedAccount?.platform || "all";

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

  const updatedLabel = formatRelativeTime(summary?.lastRefreshedAt);
  const heroTitle = selectedAccount ? selectedAccount.name
    : selectedGroup ? selectedGroup.name
      : windowFilter === "3d" ? "近三天热榜" : "今日热榜";
  const filterBadge = Number(windowFilter !== "3d") + Number(selectedGroupId !== "all") + Number(Boolean(selectedAccount));

  return (
    <div className={`page douyin-hotlist-page hl-page ${selectedEntry ? "has-detail" : ""}`}>
      <InkHero
        key={heroTitle}
        eyebrow={<>{heroDateLabel()} · {refreshing ? `正在抓取 ${Math.round(activeRefreshJob?.progress || 0)}%` : updatedLabel ? `${updatedLabel}更新` : "尚未抓取"}</>}
        title={heroTitle}
        stats={[
          { label: "在榜", value: visibleItems.length },
          { label: "新进", value: freshCount, format: (value) => `+${Math.round(value)}` },
          { label: "飙升", value: surgeCount, tone: "signal" }
        ]}
      />

      {error ? <div className="error" role="alert">{error}</div> : null}

      <section className="hl-toolbar" aria-label="榜单筛选">
        <div className="hl-chips" role="group" aria-label="平台">
          {([["all", "全部"], ["douyin", "抖音"], ["bilibili", "B站"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`hl-chip ${activePlatformFilter === value && !surgeOnly ? "active" : ""}`}
              aria-pressed={activePlatformFilter === value && !surgeOnly}
              disabled={operationBusy || initialLoading || (value !== "all" && !groupAccounts.length)}
              onClick={() => {
                setSurgeOnly(false);
                setSelectedAccountId(value === "all" ? "all" : getPlatformAccountSelection(value));
              }}
            >
              {label}{value === "all" ? <small>{visibleItems.length}</small> : null}
            </button>
          ))}
          <button
            type="button"
            className={`hl-chip is-signal ${surgeOnly ? "active" : ""}`}
            aria-pressed={surgeOnly}
            disabled={!surgeCount && !surgeOnly}
            onClick={() => setSurgeOnly((current) => !current)}
          >
            只看飙升{surgeCount ? <small>{surgeCount}</small> : null}
          </button>
          <DialogTrigger>
            <Button className={`hl-chip is-dashed ${filterBadge ? "has-filters" : ""}`} aria-label="更多筛选">
              <Plus aria-hidden="true" size={13} />筛选{filterBadge ? <small>{filterBadge}</small> : null}
            </Button>
            <Popover className="workbench-select-popover hl-filter-popover" placement="bottom start" offset={8}>
              <Dialog className="hl-filter-panel" aria-label="更多筛选">
                <div className="hl-filter-row">
                  <span>时间</span>
                  <WindowFilterControl disabled={operationBusy} onChange={setWindowFilter} value={windowFilter} />
                </div>
                <div className="hl-filter-row">
                  <span>分组</span>
                  <HotlistGroupFilter
                    groups={snapshot?.groups ?? []} selectedId={selectedGroupId} accountCount={snapshot?.accounts.length ?? 0}
                    disabled={operationBusy || !snapshot}
                    showActions={false}
                    onSelect={(group) => setSelection({ group, account: "all" })}
                    onAdd={() => setGroupEditor("new")}
                    onEdit={() => setGroupEditor(selectedGroupId)}
                    onDelete={() => undefined}
                  />
                </div>
                <div className="hl-filter-row">
                  <span>账号</span>
                  <AccountFilter
                    accounts={groupAccounts}
                    disabled={operationBusy || initialLoading || !groupAccounts.length}
                    onChange={setSelectedAccountId}
                    value={selectedAccountId}
                  />
                </div>
                {filterBadge ? (
                  <button className="btn ghost compact hl-filter-reset" type="button" onClick={() => {
                    setSelection({ group: "all", account: "all", window: "3d" });
                  }}>清除筛选</button>
                ) : null}
              </Dialog>
            </Popover>
          </DialogTrigger>
        </div>

        <div className="hl-toolbar-right">
          <label className="hl-sort">
            <span>按</span>
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
            <span>排序</span>
          </label>
          <RefreshLogMenu error={refreshLogsError} loading={refreshLogsLoading} logs={refreshLogs} />
          <MenuTrigger>
            <Button className="btn icon-only compact" aria-label="更多操作">
              <MoreHorizontal aria-hidden="true" size={17} />
            </Button>
            <Popover isNonModal className="workbench-select-popover ink-menu-popover" placement="bottom end" offset={8}>
              <Menu className="workbench-select-options ink-menu" aria-label="热榜操作">
                <MenuItem className="workbench-select-option" textValue="管理监控账号" onAction={() => setAccountDrawerOpen(true)}>
                  <SlidersHorizontal aria-hidden="true" size={14} /><span>管理监控账号</span>
                </MenuItem>
                <MenuItem className="workbench-select-option" textValue="重新读取榜单" isDisabled={operationBusy} onAction={() => void loadHotlist({ force: true })}>
                  <RefreshCw aria-hidden="true" size={14} /><span>重新读取榜单</span>
                </MenuItem>
                <MenuItem className="workbench-select-option" textValue="新建分组" isDisabled={operationBusy || !snapshot} onAction={() => setGroupEditor("new")}>
                  <FolderPlus aria-hidden="true" size={14} /><span>新建分组</span>
                </MenuItem>
                {selectedGroup ? (
                  <MenuItem className="workbench-select-option" textValue="编辑当前分组" isDisabled={operationBusy} onAction={() => setGroupEditor(selectedGroupId)}>
                    <Pencil aria-hidden="true" size={14} /><span>编辑「{selectedGroup.name}」</span>
                  </MenuItem>
                ) : null}
                {selectedGroup ? (
                  <MenuItem className="workbench-select-option is-danger" textValue="删除当前分组" isDisabled={operationBusy} onAction={() => {
                    setDeleteGroupError("");
                    setDeleteGroupTarget({ id: selectedGroup.id, name: selectedGroup.name, revision: snapshot?.groupRevision ?? 0 });
                  }}>
                    <Trash2 aria-hidden="true" size={14} /><span>删除「{selectedGroup.name}」</span>
                  </MenuItem>
                ) : null}
              </Menu>
            </Popover>
          </MenuTrigger>
          <button className="btn primary compact" aria-busy={refreshing} disabled={!canRefresh} onClick={() => void handleRefresh()} type="button">
            <TrendingUp aria-hidden="true" size={15} />
            {activeRefreshJob ? `抓取中 ${Math.round(activeRefreshJob.progress)}%` : refreshLabel}
          </button>
        </div>
      </section>
      {snapshot && selectedGroupId !== "all" && !selectedGroup ? <p className="error" role="alert">该分组不存在，请选择“全部”或重新加载。</p> : null}

      <section className="hl-content">
        {initialLoading ? (
          <HotlistLoadingRows />
        ) : shownItems.length ? (
          <HotlistTable
            items={shownItems}
            showGlobalRank={Boolean(selectedAccount)}
            selectedKey={selectedEntry ? selectedKey : null}
            onSelect={(key) => setSelectedKey((current) => current === key ? null : key)}
          />
        ) : selectedGroup && !groupAccounts.length ? (
          <div className="hl-empty"><h2>这个分组还没有账号</h2><p className="subtle">添加监控账号后，这里会集中显示它们的视频。</p><button className="btn" type="button" onClick={() => setGroupEditor(selectedGroup.id)}>选择分组账号</button></div>
        ) : (
          <EmptyHotlist hasAccounts={Boolean(snapshot?.accounts.length)} selectedAccount={selectedAccount?.name} windowLabel={windowLabel} />
        )}
      </section>
      {selectedEntry ? (
        <HotlistDetailDrawer
          entry={selectedEntry}
          position={selectedIndex}
          total={shownItems.length}
          onClose={closeDetail}
          onStep={stepDetail}
        />
      ) : null}
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
    <div className="page douyin-hotlist-page hl-page">
      <section className="hl-content">
        <HotlistLoadingRows />
      </section>
    </div>
  );
}

const heroDateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" });

function heroDateLabel() {
  return heroDateFormatter.format(new Date());
}

function formatRelativeTime(value?: string) {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}
