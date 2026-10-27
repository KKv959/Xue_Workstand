"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, CircleStop, Clock3, RefreshCw, RotateCcw, X, XCircle } from "lucide-react";
import { formatJobErrorMessage } from "@/lib/job-messages";
import { defaultJobHref, getJobResultHref } from "@/lib/job-links";
import { isActiveJob } from "@/lib/job-sync";
import type { JobRecord } from "@/lib/types";
import { useOptionalTasks } from "./TaskProvider";

const RECENT_LIMIT = 6;
const DONE_FLASH_MS = 2600;

/**
 * 任务岛：顶栏正中的黑色胶囊。后台任务在跑时显示进度，点开后胶囊原地弹簧展开成面板，
 * 不遮罩页面；任务完成时胶囊短暂变成“已完成”。
 */
export function TaskIsland() {
  const tasks = useOptionalTasks();
  const rootRef = useRef<HTMLDivElement>(null);
  const capsuleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [capsule, setCapsule] = useState({ width: 120, height: 36 });
  const [stoppingId, setStoppingId] = useState("");
  const [retryingId, setRetryingId] = useState("");
  const doneFlash = useDoneFlash(tasks?.activeJobs ?? [], tasks?.jobs ?? []);
  const activeJobs = tasks?.activeJobs ?? [];
  const activeIds = new Set(activeJobs.map((job) => job.id));
  const recentJobs = (tasks?.jobs ?? []).filter((job) => !activeIds.has(job.id)).slice(0, RECENT_LIMIT);
  const primary = activeJobs[0] ?? null;
  const progress = clamp(primary?.progress ?? 0);

  useLayoutEffect(() => {
    const element = capsuleRef.current;
    if (!element) return;
    const measure = () => setCapsule({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        capsuleRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!tasks) return null;

  const state = primary ? "running" : doneFlash ? "done" : "idle";
  const label = primary
    ? `${activeJobs.length} 个任务进行中：${primary.title}`
    : doneFlash ? `已完成：${doneFlash.title}` : "任务中心，暂无进行中任务";

  return (
    <div
      className={`island is-${state} ${open ? "is-open" : ""}`}
      ref={rootRef}
      style={{ "--capsule-w": `${capsule.width}px`, "--capsule-h": `${capsule.height}px` } as CSSProperties}
    >
      <button
        ref={capsuleRef}
        type="button"
        className="island-capsule"
        aria-expanded={open}
        aria-controls="task-island-panel"
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="island-state" aria-hidden="true">
          {state === "running" ? <span className="island-spinner" /> : state === "done" ? <Check size={14} strokeWidth={2.6} /> : <span className="island-dot" />}
        </span>
        <span className="island-text" key={state === "done" ? doneFlash?.id : state}>
          {state === "running" ? primary?.title : state === "done" ? `已完成 · ${doneFlash?.title}` : "任务"}
        </span>
        {state === "running" ? (
          <>
            <span className="island-count">{activeJobs.length > 1 ? `${activeJobs.length} 个` : primary?.status === "queued" ? "排队" : `${progress}%`}</span>
            <span className="island-rail" aria-hidden="true"><span style={{ transform: `scaleX(${progress / 100})` }} /></span>
          </>
        ) : null}
      </button>

      <div className="island-panel" id="task-island-panel" role="region" aria-label="任务" aria-hidden={!open} inert={!open}>
        <div className="island-panel-head">
          <strong>{activeJobs.length ? `${activeJobs.length} 个任务进行中` : "后台任务"}</strong>
          <div className="island-panel-tools">
            <button type="button" aria-label="刷新任务" title="刷新" aria-busy={tasks.loading} disabled={tasks.loading} onClick={() => void tasks.refreshJobs()}>
              <RefreshCw size={14} aria-hidden="true" className={tasks.loading ? "ink-spin-icon" : ""} />
            </button>
            <button type="button" aria-label="收起任务岛" title="收起（Esc）" onClick={() => setOpen(false)}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        {tasks.error ? <p className="island-error" role="alert">{tasks.error}</p> : null}

        {activeJobs.length ? (
          <ul className="island-list">
            {activeJobs.map((job, index) => (
              <li key={job.id} className="island-job is-active" style={{ "--i": index } as CSSProperties}>
                <div className="island-job-line">
                  <span className="island-job-title">{job.title}</span>
                  <span className="island-job-meta">{job.status === "queued" ? "排队中" : `${clamp(job.progress)}%`}</span>
                </div>
                <span className="island-job-detail" title={job.message}>{job.status === "queued" ? "等前面的任务完成后自动开始" : job.message}</span>
                <div className="island-job-foot">
                  <span className="island-progress" aria-hidden="true"><span style={{ transform: `scaleX(${clamp(job.progress) / 100})` }} /></span>
                  <button
                    type="button"
                    className="island-action"
                    aria-busy={stoppingId === job.id}
                    disabled={stoppingId === job.id}
                    onClick={async () => {
                      setStoppingId(job.id);
                      try { await tasks.cancelTask(job.id); } catch { /* TaskProvider 已记录错误并在面板顶部显示。 */ }
                      finally { setStoppingId(""); }
                    }}
                  >
                    {stoppingId === job.id ? "停止中" : "停止"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="island-section-title">{recentJobs.length ? "最近" : "最近没有任务记录"}</div>
        <ul className="island-list">
          {recentJobs.map((job, index) => {
            const resultHref = job.status === "completed" ? getJobResultHref(job) : "";
            const failed = job.status === "failed" || job.status === "interrupted";
            return (
              <li key={job.id} className={`island-job is-${job.status}`} style={{ "--i": index + activeJobs.length } as CSSProperties}>
                <div className="island-job-line">
                  <span className="island-job-icon" aria-hidden="true"><StatusIcon status={job.status} /></span>
                  <span className="island-job-title">{job.title}</span>
                  {resultHref ? (
                    <Link className="island-action" href={resultHref} onClick={() => setOpen(false)}>查看</Link>
                  ) : job.recoveryError ? (
                    <Link className="island-action" href={defaultJobHref(job.kind)} onClick={() => setOpen(false)}>重新发起</Link>
                  ) : failed ? (
                    <button
                      type="button"
                      className="island-action"
                      aria-busy={retryingId === job.id}
                      disabled={retryingId === job.id}
                      onClick={async () => {
                        setRetryingId(job.id);
                        try { await tasks.retryTask(job.id); } catch { /* 错误由 TaskProvider 显示。 */ }
                        finally { setRetryingId(""); }
                      }}
                    >
                      <RotateCcw size={12} aria-hidden="true" />重试
                    </button>
                  ) : null}
                </div>
                {failed || job.recoveryError ? <span className="island-job-detail is-error">{job.recoveryError || formatJobErrorMessage(job.error || job.message)}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** 活跃任务从列表里消失且已完成时，让胶囊亮起“已完成”几秒。 */
function useDoneFlash(activeJobs: JobRecord[], jobs: JobRecord[]) {
  const previousRef = useRef<Set<string> | null>(null);
  const [flash, setFlash] = useState<JobRecord | null>(null);

  useEffect(() => {
    const current = new Set(activeJobs.map((job) => job.id));
    const previous = previousRef.current;
    previousRef.current = current;
    if (!previous) return;
    const finished = jobs.find((job) => previous.has(job.id) && !current.has(job.id) && job.status === "completed" && !isActiveJob(job));
    if (!finished) return;
    setFlash(finished);
    const timer = window.setTimeout(() => setFlash(null), DONE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [activeJobs, jobs]);

  return flash;
}

function StatusIcon({ status }: { status: JobRecord["status"] }) {
  if (status === "completed") return <Check size={13} strokeWidth={2.4} />;
  if (status === "failed") return <XCircle size={13} />;
  if (status === "queued") return <Clock3 size={13} />;
  return <CircleStop size={13} />;
}

function clamp(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.min(100, Math.max(0, progress)));
}
