"use client";

import { Button, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { InkHero } from "@/components/InkHero";
import { WorkbenchSelect } from "@/components/WorkbenchSelect";
import { Suspense, useEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  CircleDollarSign,
  Clock3,
  Eye,
  Forward,
  Gauge,
  Link2,
  MessageCircle,
  MousePointerClick,
  RefreshCw,
  Search,
  Star,
  ThumbsUp,
  Trash2,
  UserRound,
  Video,
  XCircle
} from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useFeedback } from "@/components/FeedbackProvider";
import { useScopedTasks } from "@/components/TaskProvider";
import {
  deleteGrossMarginMonitorRecord,
  getGrossMarginLibrary,
  refreshGrossMarginLibraryCache,
  refreshGrossMarginMonitorRecord,
  updateGrossMarginMonitorMustFireCurrent,
  updateGrossMarginMonitorProject,
  updateGrossMarginMonitorPlayCurrent,
  updateGrossMarginMonitorPlayTarget
} from "@/lib/client";
import type { GrossMarginLibrary, GrossMarginMonitorMetric, GrossMarginMonitorRecord, GrossMarginProjectOrder } from "@/lib/types";
import { findGrossMarginProjectOrders, getGrossMarginMonitorProjectName } from "@/lib/gross-margin-projects";
import { getGrossMarginAccountDisplayName, getGrossMarginAccountNameOptions, normalizeGrossMarginAccountName } from "@/lib/gross-margin-account-names";
import { parseGrossMarginAmount, parseGrossMarginMetric } from "@/lib/gross-margin-calculator";
import { parseDate } from "@internationalized/date";
import { formatPlaySampleCoverage, formatSampleDuration, getMonitorPlayGrowth, type PlayGrowthRange } from "../_lib/monitor-growth";
import { getAutomaticMonitorRefreshRecordIds, MONITOR_AUTO_REFRESH_TITLE } from "../_lib/monitor-refresh-policy";
import { MonitorDateFilter } from "../_components/MonitorDateFilter";
import { useGrossMarginAccountRefresh } from "../_hooks/useGrossMarginAccountRefresh";
import { useGrossMarginProjects } from "../_hooks/useGrossMarginProjects";

export default function GrossMarginMonitorPage() {
  return (
    <Suspense fallback={<GrossMarginMonitorFallback />}>
      <GrossMarginMonitorPageContent />
    </Suspense>
  );
}

function GrossMarginMonitorPageContent() {
  const { notify } = useFeedback();
  const { activeJobs, recentJobs, startTask, loading: tasksLoading } = useScopedTasks({
    href: "/gross-margin/monitor",
    kinds: ["gross-margin-refresh"]
  });
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [library, setLibrary] = useState<GrossMarginLibrary | null>(null);
  useGrossMarginAccountRefresh(library, setLibrary);
  const [loading, setLoading] = useState(true);
  const projects = useGrossMarginProjects(!loading);
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 只更新数据时效的展示，不触发采集；所有卡片共用一个时钟。
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, 60_000);
    document.addEventListener("visibilitychange", updateNow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateNow);
    };
  }, [library]);
  const accountFilter = searchParams.get("q") || "";
  const rawSelectedAccount = searchParams.get("account") || "all";
  const selectedAccount = rawSelectedAccount === "all" ? "all" : normalizeGrossMarginAccountName(rawSelectedAccount);
  const projectFilter = searchParams.get("project") || "all";
  const dateFromFilter = parseDateFilter(searchParams.get("from"));
  const dateToFilter = parseDateFilter(searchParams.get("to"));
  const [deleteTarget, setDeleteTarget] = useState<GrossMarginMonitorRecord | null>(null);
  const [activeRefreshJobId, setActiveRefreshJobId] = useState("");
  const startingRefreshRef = useRef(false);
  const lastAutomaticAttemptRef = useRef(0);
  const syncedRefreshDataRevisionsRef = useRef<Map<string, number>>(new Map());
  const trackedRefreshJob = useMemo(
    () =>
      (activeRefreshJobId
        ? [...activeJobs, ...recentJobs].find((job) => job.id === activeRefreshJobId)
        : null) || activeJobs.find((job) => job.kind === "gross-margin-refresh") || null,
    [activeJobs, activeRefreshJobId, recentJobs]
  );

  const records = useMemo(() => library?.monitorRecords || [], [library]);
  const accountOptions = useMemo(() => getGrossMarginAccountNameOptions(records.map(record => record.accountName)), [records]);
  const filteredRecords = useMemo(() => {
    const keyword = accountFilter.trim().toLowerCase();
    const accountKeyword = normalizeGrossMarginAccountName(accountFilter);
    const fromTime = getDayBoundaryTime(dateFromFilter, "start");
    const toTime = getDayBoundaryTime(dateToFilter, "end");

    return records.filter((record) => {
      if (selectedAccount !== "all" && normalizeGrossMarginAccountName(record.accountName) !== selectedAccount) return false;
      if (projectFilter !== "all" && record.projectId !== projectFilter) return false;
      if (keyword) {
        const haystack = `${record.accountName || ""} ${record.title || ""} ${record.videoUrl || ""} ${record.videoKey || ""}`.toLowerCase();
        if (!haystack.includes(keyword) && (!accountKeyword || !normalizeGrossMarginAccountName(record.accountName).includes(accountKeyword))) return false;
      }

      if (fromTime !== null || toTime !== null) {
        const publishedTime = getSortTime(record.publishedAt);
        if (!Number.isFinite(publishedTime)) return false;
        if (fromTime !== null && publishedTime < fromTime) return false;
        if (toTime !== null && publishedTime > toTime) return false;
      }

      return true;
    });
  }, [accountFilter, dateFromFilter, dateToFilter, selectedAccount, projectFilter, records]);
  const sortedRecords = useMemo(
    () =>
      [...filteredRecords].sort((left, right) => {
        const publishedTimeDiff = getSortTime(right.publishedAt) - getSortTime(left.publishedAt);
        if (publishedTimeDiff !== 0) return publishedTimeDiff;
        return getSortTime(right.updatedAt) - getSortTime(left.updatedAt);
      }),
    [filteredRecords]
  );
  const monitorProjects = useMemo(() => library?.monitorProjects || [], [library]);
  const hasActiveFilters = Boolean(accountFilter.trim() || selectedAccount !== "all" || projectFilter !== "all" || dateFromFilter || dateToFilter);
  const overview = useMemo(() => {
    let highGapCount = 0;
    let refreshIssueCount = 0;

    sortedRecords.forEach((record) => {
      const gap = getOverallGap(record);
      if (getOverallGapTone(gap.percent, record.status) === "danger") highGapCount += 1;
      if (record.status === "failed" || record.status === "partial") refreshIssueCount += 1;
    });

    return { highGapCount, refreshIssueCount };
  }, [sortedRecords]);

  useEffect(() => {
    let ignore = false;
    getGrossMarginLibrary()
      .then((result) => {
        if (!ignore) setLibrary(result);
      })
      .catch((error) => {
        if (!ignore) notify({ tone: "error", message: error instanceof Error ? error.message : "读取维护监控失败" });
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [notify]);

  function updateFilters(updates: Partial<Record<"q" | "account" | "project" | "from" | "to", string>>) {
    const params = new URLSearchParams(window.location.search);
    params.delete("platform");
    for (const [key, value] of Object.entries(updates)) setOptionalQueryParam(params, key, value);
    const queryString = params.toString();
    const nextHref = queryString ? `${pathname}?${queryString}` : pathname;
    if (`${window.location.pathname}${window.location.search}` !== nextHref) {
      window.history.replaceState(null, "", nextHref);
    }
  }

  useEffect(() => {
    if (!trackedRefreshJob || !["queued", "running"].includes(trackedRefreshJob.status)) return;
    if (!activeRefreshJobId) setActiveRefreshJobId(trackedRefreshJob.id);
    if (!busy) setBusy("refresh-all");
  }, [activeRefreshJobId, busy, trackedRefreshJob]);

  useEffect(() => {
    if (!trackedRefreshJob || trackedRefreshJob.dataChange?.resource !== "gross-margin") return;
    const dataRevision = trackedRefreshJob.dataRevision || 0;
    if (dataRevision <= (syncedRefreshDataRevisionsRef.current.get(trackedRefreshJob.id) || 0)) return;
    syncedRefreshDataRevisionsRef.current.set(trackedRefreshJob.id, dataRevision);
    void refreshGrossMarginLibraryCache()
      .then(setLibrary)
      .catch((error) => notify({ tone: "error", message: error instanceof Error ? error.message : "刷新进度同步失败" }));
  }, [notify, trackedRefreshJob]);

  useEffect(() => {
    if (loading || tasksLoading || busy || startingRefreshRef.current || activeRefreshJobId || activeJobs.length) return;
    const attemptAt = Date.now();
    const lastAutomaticAttempt = recentJobs.reduce((latest, job) => job.title === MONITOR_AUTO_REFRESH_TITLE
      ? Math.max(latest, Date.parse(job.createdAt) || 0) : latest, lastAutomaticAttemptRef.current);
    // 自动抓取覆盖全部到期记录，不随临时的账号、项目筛选缩小范围。
    const recordIds = getAutomaticMonitorRefreshRecordIds(records, attemptAt, lastAutomaticAttempt);
    if (!recordIds.length) return;
    lastAutomaticAttemptRef.current = attemptAt;
    startingRefreshRef.current = true;
    setBusy("refresh-all");
    async function startAutomaticRefresh() {
      try {
        const job = await startTask({
          kind: "gross-margin-refresh", title: MONITOR_AUTO_REFRESH_TITLE,
          href: "/gross-margin/monitor", input: { recordIds }
        });
        setActiveRefreshJobId(job.id);
      } catch (error) {
        notify({ tone: "error", message: error instanceof Error ? `自动抓取启动失败：${error.message}` : "自动抓取启动失败，请手动刷新或稍后重试" });
        setBusy("");
      } finally { startingRefreshRef.current = false; }
    }
    void startAutomaticRefresh();
  }, [activeJobs.length, activeRefreshJobId, busy, loading, now, notify, recentJobs, records, startTask, tasksLoading]);

  async function handleRefreshAll() {
    if (busy || startingRefreshRef.current || activeRefreshJobId || activeJobs.length) return;
    const targetRecordIds = sortedRecords.map((record) => record.id);
    if (!targetRecordIds.length) {
      notify({ tone: "warning", message: "当前筛选下没有可刷新的监控记录" });
      return;
    }
    startingRefreshRef.current = true;
    setBusy("refresh-all");
    try {
      const job = await startTask({
        kind: "gross-margin-refresh",
        href: "/gross-margin/monitor",
        input: { recordIds: targetRecordIds }
      });
      setActiveRefreshJobId(job.id);
      notify({ tone: "info", message: "批量刷新已加入任务中心，可离开页面继续处理" });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "刷新全部失败" });
      setBusy("");
    } finally { startingRefreshRef.current = false; }
  }

  useEffect(() => {
    if (!activeRefreshJobId) return;
    const job = [...activeJobs, ...recentJobs].find((item) => item.id === activeRefreshJobId);
    if (!job || job.status === "queued" || job.status === "running") return;
    setActiveRefreshJobId("");
    setBusy("");
    if (job.status === "completed") {
      const dataRevision = job.dataRevision || 0;
      const syncedRevision = syncedRefreshDataRevisionsRef.current.get(job.id) || 0;
      if (dataRevision > 0 && syncedRevision >= dataRevision) return;
      if (dataRevision > 0) syncedRefreshDataRevisionsRef.current.set(job.id, dataRevision);
      void refreshGrossMarginLibraryCache()
        .then(setLibrary)
        .catch((error) => notify({ tone: "error", message: error instanceof Error ? error.message : "刷新结果读取失败" }));
      return;
    }
    notify({ tone: "error", message: job.error || job.message || "批量刷新未完成" });
  }, [activeJobs, activeRefreshJobId, notify, recentJobs]);

  async function handleRefreshOne(recordId: string) {
    if (busy || startingRefreshRef.current || activeRefreshJobId || activeJobs.length) return;
    startingRefreshRef.current = true;
    setBusy(`refresh-${recordId}`);
    try {
      const result = await refreshGrossMarginMonitorRecord(recordId);
      setLibrary(result.library);
      notify({
        tone: result.record.status === "failed" || result.record.status === "partial" ? "warning" : "success",
        message:
          result.record.status === "failed"
            ? "该记录刷新失败，请查看行内提示"
            : result.record.status === "partial"
              ? "监控记录已部分刷新，请查看行内提示"
              : "监控记录已刷新"
      });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "刷新监控记录失败" });
    } finally {
      startingRefreshRef.current = false;
      setBusy("");
    }
  }

  async function handleDelete(recordId: string) {
    setBusy(`delete-${recordId}`);
    try {
      const result = await deleteGrossMarginMonitorRecord(recordId);
      setLibrary(result.library);
      setDeleteTarget((current) => (current?.id === recordId ? null : current));
      notify({ tone: "success", message: "监控记录已删除" });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "删除监控记录失败" });
    } finally {
      setBusy("");
    }
  }

  async function handleUpdatePlayTarget(recordId: string, target: number) {
    setBusy(`play-target-${recordId}`);
    try {
      const result = await updateGrossMarginMonitorPlayTarget(recordId, target);
      setLibrary(result.library);
      notify({ tone: "success", message: "播放目标已更新" });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "更新播放目标失败" });
      throw error;
    } finally {
      setBusy("");
    }
  }

  async function handleUpdatePlayCurrent(recordId: string, current: number) {
    setBusy(`play-current-${recordId}`);
    try {
      const result = await updateGrossMarginMonitorPlayCurrent(recordId, current);
      setLibrary(result.library);
      notify({ tone: "success", message: "当前播放量已更新" });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "更新当前播放量失败" });
      throw error;
    } finally {
      setBusy("");
    }
  }

  async function handleUpdateMustFireCurrent(recordId: string, current: number, revision: number) {
    setBusy(`must-fire-${recordId}`);
    try {
      const result = await updateGrossMarginMonitorMustFireCurrent(recordId, current, revision);
      setLibrary(result.library);
      notify({ tone: "success", message: "必火已投金额已保存" });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "保存必火金额失败" });
      throw error;
    } finally {
      setBusy("");
    }
  }

  async function handleUpdateProject(recordId: string, orderId: string | undefined, revision: number, projectName?: string) {
    setBusy(`project-${recordId}`);
    try {
      const result = await updateGrossMarginMonitorProject(recordId, orderId, revision, projectName);
      setLibrary(result.library);
      notify({ tone: "success", message: "维护项目已保存" });
      return true;
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "保存维护项目失败，请重试" });
      return false;
    } finally { setBusy(""); }
  }

  useEffect(() => {
    if (projects.error) notify({ tone: "error", message: projects.error });
  }, [notify, projects.error]);

  async function handleCopyDifference(record: GrossMarginMonitorRecord) {
    try {
      await navigator.clipboard.writeText(buildMonitorDifferenceText(record));
      notify({ tone: "success", message: "差额文案已复制" });
    } catch (error) {
      notify({ tone: "error", message: error instanceof Error ? error.message : "复制失败" });
    }
  }

  return (
    <div className="page gross-margin-page gross-monitor-page">
      <InkHero
        className="gross-monitor-hero"
        eyebrow={hasActiveFilters ? `数据 · 已筛选 ${sortedRecords.length} / ${records.length} 条` : "数据 · 每小时自动抓取"}
        title="数据监控"
        stats={[
          { label: "监控中", value: sortedRecords.length },
          { label: "高缺口", value: overview.highGapCount, tone: overview.highGapCount ? "danger" : undefined },
          { label: "抓取异常", value: overview.refreshIssueCount, tone: overview.refreshIssueCount ? "warning" : undefined }
        ]}
      />
      <div className="gross-monitor-topbar">
        <div className="gross-monitor-toolbar">
          <div className="gross-monitor-inline-filters" role="group" aria-label="监控筛选">
            <span className="gross-monitor-search-field">
              <Search aria-hidden="true" size={14} />
              <input
                aria-label="按账号、标题或链接筛选"
                autoComplete="off"
                className="gross-monitor-inline-input"
                id="gross-monitor-account-filter"
                name="grossMonitorAccountFilter"
                onChange={(event) => updateFilters({ q: event.target.value })}
                placeholder="搜索账号或视频"
                type="search"
                value={accountFilter}
              />
            </span>
            <span className="gross-monitor-filter-group" aria-label="范围筛选">
              <label className="gross-monitor-filter-control">
                <span className="sr-only">账号</span>
                <WorkbenchSelect
                  aria-label="按账号筛选"
                  className="gross-monitor-inline-select"
                  id="gross-monitor-account-select"
                  onValueChange={(value) => updateFilters({ account: value === "all" ? "" : value })}
                  value={selectedAccount}
                >
                  <option value="all">全部账号</option>
                  {accountOptions.map(account => <option key={account.value} value={account.value}>{account.label}</option>)}
                </WorkbenchSelect>
              </label>
              <label className="gross-monitor-filter-control gross-monitor-project-control">
                <span className="sr-only">项目</span>
                <WorkbenchSelect
                  aria-label="按项目筛选"
                  className="gross-monitor-inline-select gross-monitor-project-select"
                  id="gross-monitor-project-filter"
                  onValueChange={(value) => updateFilters({ project: value === "all" ? "" : value })}
                  value={projectFilter}
                >
                  <option value="all">全部项目</option>
                  {monitorProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}（{project.count}）
                    </option>
                  ))}
                </WorkbenchSelect>
              </label>
            </span>
            <MonitorDateFilter from={dateFromFilter} to={dateToFilter} onChange={(from, to) => updateFilters({ from, to })} />
            {hasActiveFilters ? (
              <button
                className="btn subtle compact"
                onClick={() => updateFilters({ q: "", account: "", project: "", from: "", to: "" })}
                type="button"
              >
                清空
              </button>
            ) : null}
          </div>
          <div className="button-row gross-monitor-primary-action">
            <button className="btn primary compact" title="自动每小时抓取；点击立即刷新当前范围" aria-label={hasActiveFilters ? "立即刷新筛选记录" : "立即刷新全部记录"} disabled={busy === "refresh-all" || !sortedRecords.length} onClick={() => void handleRefreshAll()} type="button">
              <RefreshCw aria-hidden="true" size={15} />
              {busy === "refresh-all" ? "刷新中" : "刷新"}
            </button>
          </div>
        </div>
      </div>

      <section className="gross-monitor-board">
        {loading ? (
          <div className="gross-monitor-empty">
            <RefreshCw aria-hidden="true" size={18} />
            <p>正在读取监控记录。</p>
          </div>
        ) : hasActiveFilters && !sortedRecords.length ? (
          <div className="gross-monitor-empty">
            <p>没有符合当前筛选条件的监控记录，请调整账号、链接、项目或日期范围。</p>
          </div>
        ) : records.length ? (
          <div className="gross-monitor-card-grid" onWheel={handleHorizontalWheel}>
            {sortedRecords.map((record) => (
              <MonitorCard
                busy={busy}
                key={record.id}
                record={record}
                projectOrders={findGrossMarginProjectOrders(projects.source?.orders || [], record.platform, record.accountName)}
                onUpdateProject={handleUpdateProject}
                now={now}
                onDelete={setDeleteTarget}
                onCopy={handleCopyDifference}
                onRefresh={handleRefreshOne}
                onUpdateMustFireCurrent={handleUpdateMustFireCurrent}
                onUpdatePlayCurrent={handleUpdatePlayCurrent}
                onUpdatePlayTarget={handleUpdatePlayTarget}
              />
            ))}
          </div>
        ) : (
          <div className="gross-monitor-empty">
            <p>还没有监控记录。先在数据维护里导出文案，系统会自动保存维护目标。</p>
          </div>
        )}
      </section>
      {deleteTarget ? (
        <ConfirmDialog
          body={`会删除监控记录“${deleteTarget.title || deleteTarget.videoUrl}”，删除后无法恢复。`}
          busy={busy === `delete-${deleteTarget.id}`}
          confirmLabel="删除记录"
          title="确认删除监控记录？"
          onCancel={() => {
            if (busy !== `delete-${deleteTarget.id}`) setDeleteTarget(null);
          }}
          onConfirm={() => void handleDelete(deleteTarget.id)}
        />
      ) : null}
    </div>
  );
}

function GrossMarginMonitorFallback() {
  return (
    <div className="page gross-margin-page gross-monitor-page">
      <section className="gross-monitor-board">
        <div className="gross-monitor-empty">
          <RefreshCw aria-hidden="true" size={18} />
          <p>正在读取监控记录。</p>
        </div>
      </section>
    </div>
  );
}

function handleHorizontalWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const target = event.currentTarget;
  if (target.scrollWidth <= target.clientWidth) return;
  target.scrollLeft += event.deltaY;
  event.preventDefault();
}

function parseDateFilter(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  try { return parseDate(value).toString(); }
  catch { return ""; } // URL 中非法日期忽略，避免日历解析异常。
}

function setOptionalQueryParam(params: URLSearchParams, key: string, value: string) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

function shouldFocusInlineEdit() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
}

function MonitorAccountAvatar({ recordId }: { recordId: string }) {
  const src = `/api/gross-margin/avatar?recordId=${encodeURIComponent(recordId)}`;
  const [failedSrc, setFailedSrc] = useState("");
  const failed = failedSrc === src;
  return (
    <span className="gross-monitor-avatar" title={failed ? "头像加载失败，请刷新页面重试" : undefined} aria-hidden="true">
      <UserRound size={17} />
      {!failed ? (
        // Local binary cache, with fixed dimensions to avoid shifting card content.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" src={src} width={34} height={34} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
      ) : null}
    </span>
  );
}

function MonitorCard({
  busy,
  record,
  projectOrders,
  onUpdateProject,
  now,
  onDelete,
  onCopy,
  onRefresh,
  onUpdateMustFireCurrent,
  onUpdatePlayCurrent,
  onUpdatePlayTarget
}: {
  busy: string;
  record: GrossMarginMonitorRecord;
  projectOrders: GrossMarginProjectOrder[];
  onUpdateProject: (recordId: string, orderId: string | undefined, revision: number, projectName?: string) => Promise<boolean>;
  now: number;
  onDelete: (record: GrossMarginMonitorRecord) => void;
  onCopy: (record: GrossMarginMonitorRecord) => Promise<void>;
  onRefresh: (recordId: string) => Promise<void>;
  onUpdateMustFireCurrent: (recordId: string, current: number, revision: number) => Promise<void>;
  onUpdatePlayCurrent: (recordId: string, current: number) => Promise<void>;
  onUpdatePlayTarget: (recordId: string, target: number) => Promise<void>;
}) {
  const videoTitle = record.title || record.videoUrl;
  const projectTitle = getGrossMarginMonitorProjectName(record, projectOrders);
  const title = projectTitle || videoTitle;
  const [editingProject, setEditingProject] = useState(false);
  const showProjectPicker = editingProject || !projectTitle;
  const metrics = getDisplayMetrics(record);
  const overallGap = getOverallGap(record);
  const overallGapTone = getOverallGapTone(overallGap.percent, record.status);
  const playGrowth = getMonitorPlayGrowth(record.playSamples, now);
  const hasPlay = metrics.some((metric) => metric.service === "play");
  const activity = getPlayActivity(playGrowth);
  const visibleWarnings = record.warnings.filter((warning) => !isBlueLinkFetchWarning(warning));
  const [editingPlay, setEditingPlay] = useState(false);
  const playMetric = metrics.find((metric) => metric.service === "play");
  const canEditPlayCurrent = record.platform === "douyin";
  const [playTargetDraft, setPlayTargetDraft] = useState(playMetric ? formatEditableMetricValue(playMetric.target) : "");
  const [playCurrentDraft, setPlayCurrentDraft] = useState(
    playMetric && typeof playMetric.current === "number" ? formatEditableMetricValue(playMetric.current) : ""
  );
  const [playEditError, setPlayEditError] = useState("");
  const playCurrentInputRef = useRef<HTMLInputElement>(null);
  const playTargetInputRef = useRef<HTMLInputElement>(null);
  const playEditSubmittedRef = useRef(false);
  const [customProjectName, setCustomProjectName] = useState("");
  const [customProjectEditing, setCustomProjectEditing] = useState(false);

  useEffect(() => {
    if (!editingPlay && playMetric) {
      setPlayTargetDraft(formatEditableMetricValue(playMetric.target));
      setPlayCurrentDraft(
        typeof playMetric.current === "number" ? formatEditableMetricValue(playMetric.current) : ""
      );
      setPlayEditError("");
    }
  }, [editingPlay, playMetric, record.platform]);

  useEffect(() => {
    if (!editingPlay || !shouldFocusInlineEdit()) return;
    const input = canEditPlayCurrent ? playCurrentInputRef.current : playTargetInputRef.current;
    input?.focus();
    input?.select();
  }, [canEditPlayCurrent, editingPlay]);

  async function submitPlayEdit() {
    if (!playMetric) return;
    setPlayEditError("");
    const nextTarget = parseMetricInput(playTargetDraft);
    if (!nextTarget || nextTarget <= 0) {
      throw new Error("请输入有效的播放目标");
    }

    const nextCurrent =
      canEditPlayCurrent && playCurrentDraft.trim()
        ? parseMetricInput(playCurrentDraft)
        : typeof playMetric.current === "number"
          ? playMetric.current
          : null;
    if (canEditPlayCurrent && (nextCurrent === null || nextCurrent < 0)) {
      throw new Error("请输入有效的当前播放量");
    }

    if (nextTarget !== playMetric.target) {
      await onUpdatePlayTarget(record.id, nextTarget);
    }
    // 手动确认相同数值也是一次有效采样，用于判断采样间没有增长。
    if (canEditPlayCurrent && nextCurrent !== null) {
      await onUpdatePlayCurrent(record.id, nextCurrent);
    }
    if (nextTarget === playMetric.target && !canEditPlayCurrent) {
      setEditingPlay(false);
      return;
    }
    setEditingPlay(false);
  }

  async function handleSubmitPlayEdit() {
    // Enter 提交后收起输入框也会触发 blur，同一轮编辑只提交一次。
    if (playEditSubmittedRef.current) return;
    playEditSubmittedRef.current = true;
    try {
      await submitPlayEdit();
    } catch (error) {
      playEditSubmittedRef.current = false;
      setPlayEditError(error instanceof Error ? error.message : "播放量保存失败");
    }
  }

  function startPlayEdit() {
    playEditSubmittedRef.current = false;
    setEditingPlay(true);
  }

  function resetPlayEdit(metric: GrossMarginMonitorMetric) {
    setPlayTargetDraft(formatEditableMetricValue(metric.target));
    setPlayCurrentDraft(typeof metric.current === "number" ? formatEditableMetricValue(metric.current) : "");
    setPlayEditError("");
    setEditingPlay(false);
  }

  return (
    <article className={`gross-monitor-card ${overallGapTone === "danger" ? "high-risk" : overallGapTone === "warning" ? "mid-risk" : ""}`} aria-busy={busy === `refresh-${record.id}` || busy === "refresh-all"}>
      <div className="gross-monitor-card-main">
        <div className="gross-monitor-card-title">
          {record.platform === "bilibili" ? <MonitorAccountAvatar recordId={record.id} /> : null}
          <span className="gross-monitor-card-copy">
            <span className="gross-monitor-eyebrow">
              {record.platform !== "bilibili" ? <UserRound aria-hidden="true" size={13} /> : null}
              <span className="gross-monitor-account-name">{getGrossMarginAccountDisplayName(record.accountName) || "未命名账号"}</span>
              <em className="gross-monitor-publish-date">{formatMonthDay(record.publishedAt)}</em>
              <MenuTrigger>
                <Button className="btn compact gross-monitor-action-trigger" aria-label="监控操作">操作<ChevronDown aria-hidden="true" size={12} /></Button>
                <Popover isNonModal className="workbench-select-popover gross-monitor-action-popover" placement="bottom end" offset={4}>
                  <Menu className="workbench-select-options" aria-label="监控操作">
                    {record.videoUrl ? <MenuItem className="workbench-select-option" textValue="打开视频" href={record.videoUrl} target="_blank" rel="noreferrer"><Link2 aria-hidden="true" size={14} /><span>打开视频</span></MenuItem> : null}
                    <MenuItem className="workbench-select-option" textValue="复制差额" onAction={() => void onCopy(record)}><Copy aria-hidden="true" size={14} /><span>复制差额</span></MenuItem>
                    <MenuItem className="workbench-select-option" textValue="刷新数据" isDisabled={busy === `refresh-${record.id}` || busy === "refresh-all"} onAction={() => void onRefresh(record.id)}><RefreshCw aria-hidden="true" size={14} /><span>刷新数据</span></MenuItem>
                    <MenuItem className="workbench-select-option" textValue="修改维护项目" onAction={() => setEditingProject(true)}><Video aria-hidden="true" size={14} /><span>修改维护项目</span></MenuItem>
                    {canEditPlayCurrent && playMetric ? <MenuItem className="workbench-select-option" textValue="录入播放量" onAction={startPlayEdit}><Eye aria-hidden="true" size={14} /><span>录入播放量</span></MenuItem> : null}
                    <MenuItem className="workbench-select-option gross-monitor-delete-action" textValue="删除记录" isDisabled={busy === `delete-${record.id}`} onAction={() => onDelete(record)}><Trash2 aria-hidden="true" size={14} /><span>删除记录</span></MenuItem>
                  </Menu>
                </Popover>
              </MenuTrigger>
            </span>
            {showProjectPicker ? (
              <span className="gross-monitor-project-picker" title={`原视频：${videoTitle}`}>
                <WorkbenchSelect aria-label="选择维护项目" className="gross-monitor-project-trigger" value="" disabled={busy === `project-${record.id}`} onValueChange={orderId => {
                  if (orderId === "daily") {
                    void onUpdateProject(record.id, undefined, record.revision || 0, "日常").then(saved => { if (saved) setEditingProject(false); });
                  } else if (orderId === "custom") {
                    setCustomProjectEditing(true);
                    setCustomProjectName("");
                  } else {
                    void onUpdateProject(record.id, orderId, record.revision || 0).then(saved => { if (saved) setEditingProject(false); });
                  }
                }}>
                  <option value="" disabled>{busy === `project-${record.id}` ? "保存中…" : projectTitle || "选择维护项目"}</option>
                  {projectOrders.map(order => <option key={order.id} value={order.id}>{order.projectName}{order.date ? ` · ${order.date}` : ""}</option>)}
                  <option value="daily">日常</option>
                  <option value="custom">自定义</option>
                </WorkbenchSelect>
                {customProjectEditing ? <span className="gross-monitor-custom-project-edit"><input aria-label="自定义维护项目名称" autoFocus maxLength={80} placeholder="输入项目名称" value={customProjectName} onChange={event => setCustomProjectName(event.target.value)} onKeyDown={event => {
                  if (event.key === "Enter" && customProjectName.trim()) void onUpdateProject(record.id, undefined, record.revision || 0, customProjectName.trim()).then(saved => { if (saved) { setEditingProject(false); setCustomProjectEditing(false); } });
                  if (event.key === "Escape") { setCustomProjectEditing(false); setEditingProject(false); }
                }} /><button className="btn compact" disabled={!customProjectName.trim() || busy === `project-${record.id}`} onClick={() => void onUpdateProject(record.id, undefined, record.revision || 0, customProjectName.trim()).then(saved => { if (saved) { setEditingProject(false); setCustomProjectEditing(false); } })} type="button">保存</button></span> : null}
              </span>
            ) : <strong title={projectTitle ? `${projectTitle}｜${videoTitle}` : videoTitle}>{title}</strong>}
          </span>
        </div>
      </div>

      <div className="gross-monitor-summary-line">
        <span className={`gross-monitor-gap-summary ${overallGapTone}`} title={getOverallGapLabel(overallGap, overallGapTone, record.status)}>
          {overallGapTone === "danger" || overallGapTone === "warning" ? <AlertTriangle aria-hidden="true" size={13} /> : null}
          {overallGapTone === "danger" ? "高缺口" : "目标缺口"} <strong>{formatOverallGap(overallGap, record.status)}</strong>
        </span>
        {record.status === "failed" || record.status === "partial" ? (
          <span className={`gross-monitor-refresh-state ${record.status}`}>{renderStatusIcon(record.status)}{formatStatus(record.status)}</span>
        ) : hasPlay ? (
          <span className={`gross-monitor-activity ${activity.tone}`} aria-live="polite" title={playGrowth.latest ? `播放采样：${formatDateTime(playGrowth.latest.capturedAt)}` : "暂无播放采样"}>
            <span aria-hidden="true" />{activity.label}
          </span>
        ) : null}
      </div>

      {hasPlay ? (
        <section className="gross-monitor-growth" aria-label="播放增长监测">
          <div className="gross-monitor-growth-values">
            <div title={formatPlayGrowthTitle(playGrowth.recent, record.platform)}>
              <span>最近变化</span>
              <strong className={playGrowth.stale ? "muted" : getGrowthTone(playGrowth.recent)}>{formatPlayGrowth(playGrowth.recent, record.platform)}</strong>
              <small>{playGrowth.recent ? `间隔${formatSampleDuration(playGrowth.recent.durationMs)}` : "待对比"}</small>
            </div>
            <div title={formatPlayGrowthTitle(playGrowth.day, record.platform)}>
              <span>24h采样增长</span>
              <strong className={playGrowth.stale ? "muted" : getGrowthTone(playGrowth.day)}>{formatPlayGrowth(playGrowth.day, record.platform)}</strong>
              <small className="gross-monitor-coverage">{playGrowth.day ? formatPlaySampleCoverage(playGrowth.day) : "待采样"}</small>
            </div>
          </div>
        </section>
      ) : null}

      <div className="gross-monitor-metric-list" aria-label={formatTargetSummary(record)}>
        {metrics.map((metric) => {
          const refreshDelta = getMetricRefreshDelta(record, metric.service);
          const hasVisibleDelta = refreshDelta !== null && refreshDelta !== 0;
          const deltaTone = refreshDelta === null ? "" : refreshDelta > 0 ? "positive" : refreshDelta < 0 ? "negative" : "neutral";
          const deltaLabel = hasVisibleDelta ? `，本次刷新 ${formatMetricRefreshDelta(refreshDelta, metric.service, record.platform)}` : "";

          return (
            <span
              aria-label={`${getMetricLabel(metric)}，目标 ${formatMetric(metric.target, record.platform)}，当前 ${formatMetricCurrentValue(metric, record.platform)}，缺口比例 ${formatMetricPercent(metric)}${deltaLabel}`}
              className={`gross-monitor-metric-cell ${metric.highRisk ? "danger" : ""}`}
              key={metric.service}
              title={`${getMetricLabel(metric)} | 目标 ${formatMetric(metric.target, record.platform)} | 当前 ${formatMetricCurrentValue(metric, record.platform)} | ${formatMetricPercent(metric)}${hasVisibleDelta ? ` | 本次刷新 ${formatMetricRefreshDelta(refreshDelta, metric.service, record.platform)}` : ""}`}
            >
              <span className="gross-monitor-metric-cell-head">
                {renderMetricIcon(metric.service)}
                <strong>{getMetricLabel(metric)}</strong>
                <b className={metric.highRisk ? "risk-text" : ""}>{formatMetricPercent(metric)}</b>
              </span>
              <span className="gross-monitor-metric-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${getMetricProgress(metric) / 100})` }} />
              </span>
              <span className="gross-monitor-metric-cell-values">
                <span className="gross-monitor-metric-cell-value-main">
                  {metric.service === "mustFire" ? (
                    <MustFireCurrentEditor metric={metric} record={record} onSave={onUpdateMustFireCurrent} />
                  ) : metric.service === "play" ? (
                    <em
                      className={`gross-monitor-play-edit ${editingPlay ? "editing" : ""}`}
                      onDoubleClick={startPlayEdit}
                      title="双击修改播放目标"
                    >
                      {editingPlay ? (
                        <span className="gross-monitor-play-edit-fields">
                          {canEditPlayCurrent ? (
                            <input
                              aria-label="当前播放量"
                              autoComplete="off"
                              className="gross-monitor-play-input"
                              disabled={busy === `play-current-${record.id}` || busy === `play-target-${record.id}`}
                              name={`playCurrent-${record.id}`}
                              ref={playCurrentInputRef}
                              onBlur={(event) => {
                                if (event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) return;
                                void handleSubmitPlayEdit();
                              }}
                              onChange={(event) => {
                                setPlayCurrentDraft(event.target.value);
                                setPlayEditError("");
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void handleSubmitPlayEdit();
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  resetPlayEdit(metric);
                                }
                              }}
                              placeholder="当前…"
                              type="text"
                              value={playCurrentDraft}
                            />
                          ) : null}
                          <input
                            aria-label="播放目标"
                            autoComplete="off"
                            className="gross-monitor-play-input"
                            disabled={busy === `play-current-${record.id}` || busy === `play-target-${record.id}`}
                            name={`playTarget-${record.id}`}
                            ref={playTargetInputRef}
                            onBlur={(event) => {
                              if (event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) return;
                              void handleSubmitPlayEdit();
                            }}
                            onChange={(event) => {
                              setPlayTargetDraft(event.target.value);
                              setPlayEditError("");
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void handleSubmitPlayEdit();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                resetPlayEdit(metric);
                              }
                            }}
                            placeholder="目标…"
                            type="text"
                            value={playTargetDraft}
                          />
                          {playEditError ? (
                            <span className="gross-monitor-play-error" role="alert">
                              {playEditError}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <>
                          {formatMetricCurrentValue(metric, record.platform)} / {formatMetric(metric.target, record.platform)}
                        </>
                      )}
                    </em>
                  ) : (
                    <em>{formatMetricCurrentValue(metric, record.platform)} / {formatMetric(metric.target, record.platform)}</em>
                  )}
                </span>
                {hasVisibleDelta ? (
                  <span className={`gross-monitor-metric-delta ${deltaTone}`}>
                    {formatMetricRefreshDelta(refreshDelta, metric.service, record.platform)}
                  </span>
                ) : null}
              </span>
            </span>
          );
        })}
        {!record.metrics.length ? <span className="gross-monitor-more-metrics muted">无可监控目标</span> : null}
      </div>

      {visibleWarnings.length ? (
        <p className="gross-monitor-warning">
          <AlertTriangle aria-hidden="true" size={13} />
          {visibleWarnings[0]}
        </p>
      ) : null}

    </article>
  );
}

function MustFireCurrentEditor({ metric, record, onSave }: {
  metric: GrossMarginMonitorMetric;
  record: GrossMarginMonitorRecord;
  onSave: (recordId: string, current: number, revision: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const submitted = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing && shouldFocusInlineEdit()) { input.current?.focus(); input.current?.select(); }
  }, [editing]);
  function start() {
    revision.current = record.revision ?? 0;
    submitted.current = false;
    setDraft(typeof metric.current === "number" ? String(metric.current) : "");
    setError("");
    setEditing(true);
  }
  async function save() {
    if (submitted.current) return;
    const current = parseGrossMarginAmount(draft);
    if (!draft.trim() || current === null || !Number.isInteger(current)) { setError("请填写非负整元金额"); return; }
    submitted.current = true;
    setSaving(true);
    try {
      await onSave(record.id, current, revision.current);
      setEditing(false);
    } catch (cause) {
      submitted.current = false;
      setError(cause instanceof Error ? cause.message : "保存必火金额失败");
    } finally { setSaving(false); }
  }
  return editing ? (
    <span className="gross-monitor-manual-edit">
      <input aria-label="必火已投金额（元）" aria-busy={saving} autoComplete="off" inputMode="numeric" className="gross-monitor-play-input" ref={input} value={draft} disabled={saving}
        onChange={event => { setDraft(event.target.value); setError(""); }} onBlur={() => void save()}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); void save(); }
          if (event.key === "Escape") { event.preventDefault(); submitted.current = true; setEditing(false); }
        }} />
      {error ? <span className="gross-monitor-play-error" role="alert">{error}</span> : null}
    </span>
  ) : (
    <em className="gross-monitor-play-edit" role="button" tabIndex={0} aria-label="填写必火已投金额" title="双击填写累计已投金额（元）" onDoubleClick={start}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); start(); } }}>
      {typeof metric.current === "number" ? `${metric.current.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元` : "双击填写"} / {metric.target.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元
    </em>
  );
}

function formatTargetSummary(record: GrossMarginMonitorRecord) {
  return record.metrics
    .slice(0, 4)
    .map((metric) => `${getMetricLabel(metric)}${formatMetric(metric.target, record.platform)}`)
    .join("，") || "无可监控目标";
}

function buildMonitorDifferenceText(record: GrossMarginMonitorRecord) {
  const lines = getDisplayMetrics(record)
    .filter((metric) => metric.difference > 0)
    .map((metric) => `${getMetricLabel(metric)}：${formatGapMetric(metric.difference, metric.service, record.platform)}`)
    .filter(Boolean);
  const growth = getMonitorPlayGrowth(record.playSamples, Date.now());
  const growthLines = growth.day ? [
    `近24小时采样增长：${formatPlayGrowth(growth.day, record.platform)}`,
    `采样时段：${formatDateTime(growth.day.first.capturedAt)} 至 ${formatDateTime(growth.day.latest.capturedAt)}（实测${formatSampleDuration(growth.day.durationMs)}）${growth.stale ? "，数据待更新" : ""}`
  ] : [];

  return ["目前差额：", ...lines, ...growthLines].join("\n");
}

function isBlueLinkFetchWarning(warning: string) {
  return warning.includes("蓝链点击目前没有稳定公开抓取来源");
}

function getMetricLabel(metric: GrossMarginMonitorMetric) {
  if (metric.service === "play") return "播放";
  return metric.label;
}

function getDisplayMetrics(record: GrossMarginMonitorRecord) {
  const order: GrossMarginMonitorMetric["service"][] = ["play", "danmaku", "comment", "like", "favorite", "coin", "share", "blueLink", "douPlus", "mustFire"];
  const index = new Map(order.map((service, position) => [service, position]));
  return [...record.metrics].sort((left, right) => (index.get(left.service) ?? 999) - (index.get(right.service) ?? 999));
}

function getPlayActivity(growth: ReturnType<typeof getMonitorPlayGrowth>) {
  if (!growth.latest) return { label: "待采样", tone: "pending" };
  if (growth.stale) return { label: "待更新", tone: "pending" };
  if (!growth.recent) return { label: "待对比", tone: "pending" };
  if (growth.recent.delta > 0) return { label: "有增长", tone: "positive" };
  if (growth.recent.delta < 0) return { label: "有回落", tone: "negative" };
  return { label: "未增长", tone: "neutral" };
}

function getGrowthTone(range: PlayGrowthRange | null) {
  return range === null ? "muted" : range.delta > 0 ? "positive" : range.delta < 0 ? "negative" : "";
}

function getOverallGap(record: GrossMarginMonitorRecord) {
  const refreshedMetrics = record.metrics.filter((metric) => typeof metric.current === "number" && metric.target > 0);
  const target = refreshedMetrics.reduce((sum, metric) => sum + metric.target, 0);
  const difference = refreshedMetrics.reduce((sum, metric) => sum + metric.difference, 0);
  return {
    difference,
    percent: target > 0 ? difference / target : 0,
    target
  };
}

function getOverallGapTone(percent: number, status: GrossMarginMonitorRecord["status"]) {
  if (status === "pending") return "neutral";
  if (percent >= 0.75) return "danger";
  if (status === "partial") return "warning";
  if (percent >= 0.45) return "warning";
  if (percent >= 0.0005) return "calm";
  return "neutral";
}

function getOverallGapLabel(
  gap: { percent: number; target: number },
  tone: ReturnType<typeof getOverallGapTone>,
  status: GrossMarginMonitorRecord["status"]
) {
  if (!gap.target) return status === "pending" ? "等待首刷" : "暂无目标";
  if (status === "failed") return "刷新失败";
  if (status === "partial") return "数据不完整";
  if (tone === "danger") return "严重缺口";
  if (tone === "warning") return "较大缺口";
  if (tone === "calm") return "轻微缺口";
  if (gap.percent > 0) return "基本达标";
  return "已达目标";
}

function formatStatus(status: GrossMarginMonitorRecord["status"]) {
  if (status === "completed") return "已刷新";
  if (status === "partial") return "部分刷新";
  if (status === "failed") return "失败";
  return "待刷新";
}

function formatOverallGap(gap: { percent: number; target: number }, status: GrossMarginMonitorRecord["status"]) {
  if (!gap.target) return status === "pending" ? "待刷新" : "无目标";
  return formatPercent(gap.percent);
}

function formatMetricPercent(metric: GrossMarginMonitorMetric) {
  if (metric.manualOnly && metric.service !== "mustFire") return "/";
  if (metric.service === "mustFire" && typeof metric.current !== "number") return "待填写";
  if (typeof metric.current !== "number") return "待刷新";
  return formatPercent(metric.differencePercent);
}

function formatMetricCurrentValue(metric: GrossMarginMonitorMetric, platform: GrossMarginMonitorRecord["platform"]) {
  if (metric.service === "mustFire" && typeof metric.current === "number") return `${metric.current.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}元`;
  if (metric.manualOnly && typeof metric.current !== "number") return "手动确认";
  if (typeof metric.current !== "number") return "未刷新";
  return formatMetric(metric.current, platform);
}

function getMetricProgress(metric: GrossMarginMonitorMetric) {
  if (typeof metric.current !== "number") return 0;
  return Math.min(100, Math.max(0, (metric.current / metric.target) * 100));
}

function getMetricRefreshDelta(record: GrossMarginMonitorRecord, service: GrossMarginMonitorMetric["service"]) {
  const current = record.currentStats?.[service];
  if (typeof current !== "number" || record.status === "failed" || record.status === "pending") return null;
  if (service === "mustFire" || (service === "play" && record.platform === "douyin")) return null;
  const previous = record.previousStats?.[service];
  return typeof previous === "number" ? current - previous : null;
}

function renderStatusIcon(status: GrossMarginMonitorRecord["status"]) {
  if (status === "completed") return <CheckCircle2 aria-hidden="true" size={13} />;
  if (status === "partial") return <AlertTriangle aria-hidden="true" size={13} />;
  if (status === "failed") return <XCircle aria-hidden="true" size={13} />;
  return <Clock3 aria-hidden="true" size={13} />;
}

function renderMetricIcon(service: GrossMarginMonitorMetric["service"]) {
  if (service === "play") return <Eye aria-hidden="true" size={13} />;
  if (service === "like") return <ThumbsUp aria-hidden="true" size={13} />;
  if (service === "coin" || service === "douPlus" || service === "mustFire") return <CircleDollarSign aria-hidden="true" size={13} />;
  if (service === "favorite") return <Star aria-hidden="true" size={13} />;
  if (service === "comment") return <MessageCircle aria-hidden="true" size={13} />;
  if (service === "share") return <Forward aria-hidden="true" size={13} />;
  if (service === "danmaku") return <Video aria-hidden="true" size={13} />;
  if (service === "blueLink") return <MousePointerClick aria-hidden="true" size={13} />;
  return <Gauge aria-hidden="true" size={13} />;
}

function formatMetric(value: number, platform: GrossMarginMonitorRecord["platform"]) {
  if (value >= 10000) return `${stripZeros((value / 10000).toFixed(2))}${platform === "bilibili" ? "W" : "万"}`;
  return String(Math.round(value));
}

function formatGapMetric(value: number, service: GrossMarginMonitorMetric["service"], platform: GrossMarginMonitorRecord["platform"]) {
  if (service === "play" && value >= 10000) {
    return `${stripZeros((value / 10000).toFixed(2))}${platform === "bilibili" ? "W" : "万"}`;
  }
  return String(Math.round(value));
}

function formatMetricRefreshDelta(value: number, service: GrossMarginMonitorMetric["service"], platform: GrossMarginMonitorRecord["platform"]) {
  if (value === 0) return "0";
  const sign = value > 0 ? "+" : "-";
  const absolute = Math.abs(value);
  return `${sign}${formatGapMetric(absolute, service, platform)}`;
}

function formatPlayGrowth(range: PlayGrowthRange | null, platform: GrossMarginMonitorRecord["platform"]) {
  return range ? formatMetricRefreshDelta(range.delta, "play", platform) : "—";
}

function formatPlayGrowthTitle(range: PlayGrowthRange | null, platform: GrossMarginMonitorRecord["platform"]) {
  if (!range) return "至少需要两次有效播放采样；未采样不代表没有增长。";
  return `${formatDateTime(range.first.capturedAt)} 至 ${formatDateTime(range.latest.capturedAt)}：${formatMetric(range.first.value, platform)} → ${formatMetric(range.latest.value, platform)}。实测${formatSampleDuration(range.durationMs)}，${range.sampleCount}次采样。仅计算实际采样差值，不推算未覆盖时段，也不代表投放带来的净增长。`;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatEditableMetricValue(value: number) {
  return String(Math.round(value));
}

function parseMetricInput(value: string) {
  const parsed = parseGrossMarginMetric(value);
  return parsed === null ? null : Math.round(parsed);
}

function stripZeros(value: string) {
  return value.replace(/\.?0+$/, "");
}

function formatDateTime(value?: string) {
  if (!value) return "尚未刷新";
  const date = new Date(value);
  if (Number.isNaN(+date)) return "时间无效";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatMonthDay(value?: string) {
  if (!value) return "--/--";
  const date = new Date(value);
  if (Number.isNaN(+date)) return "--/--";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
}

function getSortTime(value?: string) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = +new Date(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function getDayBoundaryTime(value: string, mode: "start" | "end") {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return mode === "start"
    ? new Date(year, month, day, 0, 0, 0, 0).getTime()
    : new Date(year, month, day, 23, 59, 59, 999).getTime();
}
