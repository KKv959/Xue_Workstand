"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, ChevronDown, CircleStop, Clock3, ListTodo, Loader2, RefreshCw, X, XCircle } from "lucide-react";
import { formatJobErrorMessage } from "@/lib/job-messages";
import { defaultJobHref, getJobResultHref } from "@/lib/job-links";
import { isActiveJob } from "@/lib/job-sync";
import type { JobRecord } from "@/lib/types";
import { useOptionalTasks } from "./TaskProvider";
import { ModalBackdrop } from "./ModalBackdrop";

const RECENT_COLLAPSED_COUNT = 4;

type TaskDrawerPosition = CSSProperties & {
  "--task-drawer-bottom"?: string;
  "--task-drawer-left"?: string;
  "--task-drawer-width"?: string;
};

export function TaskCenter({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const tasks = useOptionalTasks();
  const drawerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [drawerPosition, setDrawerPosition] = useState<TaskDrawerPosition>();
  const [stoppingJobId, setStoppingJobId] = useState("");
  const [retryingJobId, setRetryingJobId] = useState("");
  const activeJobs = tasks?.activeJobs ?? [];
  const activeJobIds = new Set(activeJobs.map((job) => job.id));
  const recentJobs = tasks?.jobs.filter((job) => !activeJobIds.has(job.id)) ?? [];
  const visibleRecentJobs = recentExpanded ? recentJobs : recentJobs.slice(0, RECENT_COLLAPSED_COUNT);
  const activeCount = activeJobs.length;
  const primaryJob = activeJobs[0] || null;
  const displayJob = primaryJob;
  const progress = clampProgress(displayJob?.progress ?? 0);
  const progressStyle = {
    "--progress-scale": `${progress / 100}`
  } as CSSProperties;

  const updateDrawerPosition = useCallback(() => {
    if (variant === "mobile" || typeof window === "undefined" || window.innerWidth <= 900) {
      setDrawerPosition(undefined);
      return;
    }

    const trigger = triggerRef.current;
    if (!trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    // DOMRect uses visual pixels; fixed positioning still inherits the page zoom.
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const viewportWidth = window.innerWidth / zoom;
    const viewportHeight = window.innerHeight / zoom;
    const triggerRight = triggerRect.right / zoom;
    const viewportEdge = 16;
    const triggerGap = 12;
    const availableWidth = viewportWidth - triggerRight - triggerGap - viewportEdge;
    const width = Math.min(420, Math.max(320, availableWidth));
    const left = Math.max(
      viewportEdge,
      Math.min(triggerRight + triggerGap, viewportWidth - width - viewportEdge)
    );
    const bottom = Math.max(viewportEdge, viewportHeight - triggerRect.bottom / zoom);

    setDrawerPosition({
      "--task-drawer-bottom": `${Math.round(bottom)}px`,
      "--task-drawer-left": `${Math.round(left)}px`,
      "--task-drawer-width": `${Math.round(width)}px`
    });
  }, [variant]);

  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => updateDrawerPosition();

    updateDrawerPosition();
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
    };
  }, [open, updateDrawerPosition]);

  const toggleOpen = () => {
    if (!open) updateDrawerPosition();
    setOpen((current) => !current);
  };

  if (!tasks) return null;

  return (
    <div className={`task-center ${variant === "mobile" ? "task-center-mobile" : ""}`}>
      {variant === "mobile" ? (
        <button
          aria-controls={drawerId}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={taskCenterLabel(activeCount, displayJob)}
          className={`mobile-task-trigger ${activeCount ? "active" : ""}`}
          onClick={toggleOpen}
          ref={triggerRef}
          type="button"
        >
          <ListTodo aria-hidden="true" size={20} />
          {activeCount ? <span>{activeCount}</span> : null}
        </button>
      ) : (
        <button
          aria-controls={drawerId}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={taskCenterLabel(activeCount, displayJob)}
          className={`task-center-trigger ${activeCount ? "active" : ""}`}
          onClick={toggleOpen}
          ref={triggerRef}
          type="button"
        >
          <span className="task-center-trigger-copy">
            <strong>任务中心</strong>
            <small>{displayJob ? displayJob.message : "暂无运行任务 · 查看记录"}</small>
          </span>
          {primaryJob ? <span aria-hidden="true" className="task-center-rail">
            <span className="task-center-rail-fill" style={progressStyle} />
          </span> : null}
          {primaryJob ? <span className="task-center-trigger-meta">
            <span>{activeCount}</span>
            <small>{primaryJob.status === "queued" ? "排队中" : `${clampProgress(primaryJob.progress)}%`}</small>
          </span> : <ChevronDown aria-hidden="true" size={14} />}
        </button>
      )}

      {open ? (
          <ModalBackdrop
            backdropClassName="task-center-backdrop"
            onClose={() => setOpen(false)}
            aria-label="任务中心"
            className="task-center-drawer"
            id={drawerId}
            style={drawerPosition}
          >
            <header className="task-center-drawer-header">
              <div>
                <h2>任务中心</h2>
                <p className="subtle">查看后台任务进度与结果</p>
              </div>
              <div className="task-center-drawer-actions">
                <button
                  aria-busy={tasks.loading}
                  aria-label="刷新任务"
                  className="btn icon-only compact"
                  disabled={tasks.loading}
                  onClick={() => void tasks.refreshJobs()}
                  title="刷新任务"
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={15} />
                </button>
                <button aria-label="关闭任务中心" className="btn icon-only compact" onClick={() => setOpen(false)} title="关闭" type="button">
                  <X aria-hidden="true" size={15} />
                </button>
              </div>
            </header>

            {tasks.error ? <div className="task-center-error" role="alert">{tasks.error}</div> : null}

            <div className="task-center-drawer-body">
              {activeJobs.length ? (
                <TaskSection
                  title="进行中"
                  jobs={activeJobs}
                  onCancel={async (jobId) => {
                    setStoppingJobId(jobId);
                    try {
                      await tasks.cancelTask(jobId);
                    } catch {
                      // TaskProvider 已在任务中心展示停止失败的错误。
                    } finally {
                      setStoppingJobId((current) => (current === jobId ? "" : current));
                    }
                  }}
                  onNavigate={() => setOpen(false)}
                  stoppingJobId={stoppingJobId}
                />
              ) : null}
              {recentJobs.length ? (
                <TaskSection
                  collapsible={recentJobs.length > RECENT_COLLAPSED_COUNT ? {
                    expanded: recentExpanded,
                    onToggle: () => setRecentExpanded((current) => !current)
                  } : undefined}
                  jobs={visibleRecentJobs}
                  onCancel={async () => undefined}
                  onRetry={async (jobId) => {
                    setRetryingJobId(jobId);
                    try {
                      await tasks.retryTask(jobId);
                    } catch {
                      // TaskProvider 会在任务中心展示可操作的错误信息。
                    } finally {
                      setRetryingJobId((current) => (current === jobId ? "" : current));
                    }
                  }}
                  onNavigate={() => setOpen(false)}
                  readOnly
                  retryingJobId={retryingJobId}
                  stoppingJobId={stoppingJobId}
                  title="最近任务"
                  totalCount={recentJobs.length}
                />
              ) : null}
              {!activeJobs.length && !recentJobs.length ? (
                <p className="task-center-more">最近没有任务记录。</p>
              ) : null}
            </div>
          </ModalBackdrop>
      ) : null}
    </div>
  );
}

function TaskSection({
  jobs,
  onCancel,
  onNavigate,
  onRetry,
  retryingJobId = "",
  stoppingJobId,
  title,
  totalCount = jobs.length,
  collapsible,
  readOnly = false
}: {
  jobs: JobRecord[];
  onCancel: (jobId: string) => Promise<void>;
  onNavigate: () => void;
  onRetry?: (jobId: string) => Promise<void>;
  retryingJobId?: string;
  stoppingJobId: string;
  title: string;
  totalCount?: number;
  collapsible?: {
    expanded: boolean;
    onToggle: () => void;
  };
  readOnly?: boolean;
}) {
  return (
    <section className={`task-center-section ${readOnly ? "is-recent" : "is-active"}`}>
      <div className="task-center-section-title">
        <div className="task-center-section-heading">
          <h3>{title}</h3>
          <span className="task-center-section-count">{totalCount}</span>
        </div>
        {collapsible ? (
          <button
            aria-expanded={collapsible.expanded}
            className="task-center-section-toggle"
            onClick={collapsible.onToggle}
            type="button"
          >
            <span>{collapsible.expanded ? "收起" : "展开全部"}</span>
            <ChevronDown aria-hidden="true" className={collapsible.expanded ? "is-expanded" : ""} size={14} />
          </button>
        ) : null}
      </div>
      <div className="task-center-list">
        {jobs.map((job) => (
          <TaskRow
            job={job}
            key={job.id}
            onCancel={onCancel}
            onNavigate={onNavigate}
            onRetry={onRetry}
            readOnly={readOnly}
            retrying={retryingJobId === job.id}
            stopping={stoppingJobId === job.id}
          />
        ))}
      </div>
    </section>
  );
}

function TaskRow({
  job,
  onCancel,
  onNavigate,
  onRetry,
  stopping,
  retrying,
  readOnly
}: {
  job: JobRecord;
  onCancel: (jobId: string) => Promise<void>;
  onNavigate: () => void;
  onRetry?: (jobId: string) => Promise<void>;
  stopping: boolean;
  retrying?: boolean;
  readOnly?: boolean;
}) {
  const detail = taskDetail(job);
  const progress = clampProgress(job.progress);
  const resultHref = getJobResultHref(job);
  return (
    <div className={`task-center-row ${job.status} ${readOnly ? "is-recent" : "is-active"}`}>
      <span className={`task-center-row-state ${job.status}`}>
        <TaskStatusIcon status={job.status} />
      </span>
      <span className="task-center-row-copy">
        <strong>{job.title}</strong>
        <small title={detail}>{detail}</small>
      </span>
      <div className="task-center-row-controls">
        <span className="task-center-row-meta">
          <span>{job.recoveryError ? "无法恢复" : formatJobStatus(job.status)}</span>
          {isActiveJob(job) && job.status === "running" ? <span>{progress}%</span> : null}
        </span>
        {!readOnly && isActiveJob(job) ? (
          <button
            aria-busy={stopping}
            aria-label={`停止任务：${job.title}`}
            className="btn small task-center-row-stop"
            disabled={stopping}
            onClick={() => void onCancel(job.id)}
            type="button"
          >
            {stopping ? "停止中…" : "停止"}
          </button>
        ) : null}
        {readOnly && job.status === "completed" && resultHref ? (
          <Link className="btn small ghost task-center-row-action" href={resultHref} onClick={onNavigate}>
            {job.kind === "write-copy" ? "查看文案" : job.resultRef?.label || "查看结果"}
          </Link>
        ) : null}
        {readOnly && job.recoveryError ? (
          <Link className="btn small ghost task-center-row-action" href={defaultJobHref(job.kind)} onClick={onNavigate}>重新发起</Link>
        ) : null}
        {readOnly && !job.recoveryError && (job.status === "failed" || job.status === "interrupted") && onRetry ? (
          <button
            aria-busy={retrying}
            className="btn small ghost task-center-row-action"
            disabled={retrying}
            onClick={() => void onRetry(job.id)}
            type="button"
          >
            {retrying ? "重试中…" : "重试"}
          </button>
        ) : null}
      </div>
      {isActiveJob(job) && job.status === "running" ? (
        <span className="task-center-row-progress" aria-label={`任务进度 ${job.progress}%`}>
          <span style={{ "--progress-scale": `${progress / 100}` } as CSSProperties} />
        </span>
      ) : null}
    </div>
  );
}

function taskDetail(job: JobRecord) {
  if (job.recoveryError) return job.recoveryError;
  if (job.status === "queued") return "等待前面的任务完成后自动开始";
  if (job.status === "failed") return formatJobErrorMessage(job.error || job.message);
  return job.message;
}

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, progress));
}

function formatJobStatus(status: JobRecord["status"]) {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已停止";
  return "已中断";
}

function taskCenterLabel(activeCount: number, displayJob: JobRecord | null) {
  const activeLabel = `${activeCount} 个进行中任务`;
  if (!displayJob) return `打开任务中心，${activeLabel}`;
  return `打开任务中心，${activeLabel}，${displayJob.message}`;
}

function TaskStatusIcon({ status }: { status: JobRecord["status"] }) {
  if (status === "queued") return <Clock3 aria-hidden="true" size={15} />;
  if (status === "running") return <Loader2 aria-hidden="true" size={15} />;
  if (status === "completed") return <CheckCircle2 aria-hidden="true" size={14} />;
  if (status === "failed") return <XCircle aria-hidden="true" size={14} />;
  return <CircleStop aria-hidden="true" size={14} />;
}
