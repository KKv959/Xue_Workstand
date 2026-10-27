"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronRight, FileText, Search } from "lucide-react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/CommandPalette";
import { useLibrary } from "@/components/LibraryProvider";
import { useRemoteStatus } from "@/components/RemoteStatusProvider";
import { useOptionalTasks } from "@/components/TaskProvider";
import { getCachedDouyinHotlist, getDouyinHotlist } from "@/lib/client";
import { buildWriterDraftHref } from "@/lib/draft-links";
import type { DouyinHotlistResponse, JobRecord } from "@/lib/types";

const HOTLIST_WINDOW = "3d";
const numberFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

/** 手机“今天”：一屏回答后台在不在、任务跑到哪、现在什么在火。 */
export default function MobileHomePage() {
  const { library, loading: libraryLoading, error: libraryError, refresh: refreshLibrary } = useLibrary();
  const tasks = useOptionalTasks();
  const remote = useRemoteStatus();
  const hotlist = useTopHotlist();
  const activeJobs = tasks?.activeJobs ?? [];
  const failedJobs = tasks?.recentJobs.filter((job) => job.status === "failed" || job.status === "interrupted") ?? [];

  return (
    <div className="mobile-home today-page page">
      <header className="today-head">
        <div>
          <button
            type="button"
            className={`today-status ${remote.connection}`}
            onClick={() => void remote.refresh({ fresh: true })}
            aria-label="重新检查后台状态"
          >
            <span aria-hidden="true" />
            {connectionLabel(remote.connection)} · {formatCheckedAt(remote.status?.checkedAt)}
          </button>
          <h1>今天</h1>
        </div>
        <button
          type="button"
          className="today-search"
          aria-label="搜索页面和账号"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
        >
          <Search size={19} aria-hidden="true" />
        </button>
      </header>

      <TaskCard jobs={activeJobs} onCancel={tasks?.cancelTask} />

      <section className="today-section">
        <div className="today-section-head">
          <h2>热榜前 5</h2>
          <Link href="/douyin-hotlist">全部 {hotlist.total || ""} <ChevronRight size={15} aria-hidden="true" /></Link>
        </div>
        <div className="today-card today-hotlist">
          {hotlist.items.length ? hotlist.items.map((item, index) => (
            <Link
              key={`${item.account.id}:${item.video.id}`}
              className="today-hot-row"
              href={`/douyin-hotlist`}
              style={{ "--i": index } as CSSProperties}
            >
              <span className={`today-hot-rank ${index === 0 ? "is-top" : ""}`}>{index + 1}</span>
              <span className="today-hot-cover">
                {item.video.coverUrl ? <Image alt="" src={item.video.coverUrl} width={120} height={76} unoptimized referrerPolicy="no-referrer" /> : null}
              </span>
              <span className="today-hot-copy">
                <strong>{item.video.title}</strong>
                <small>{numberFormatter.format(item.heatScore)} 热度{item.surge ? <em>飙升</em> : null}</small>
              </span>
            </Link>
          )) : (
            <p className="today-empty">{hotlist.error ? hotlist.error : hotlist.loading ? "正在读取热榜…" : "还没有热榜数据，去热榜页添加账号并抓取。"}</p>
          )}
        </div>
      </section>

      {failedJobs.length ? (
        <section className="today-section">
          <div className="today-section-head">
            <h2>需要处理</h2>
          </div>
          <div className="today-card">
            {failedJobs.slice(0, 3).map((job) => (
              <Link className="today-row is-danger" href={job.href || "/mobile"} key={job.id}>
                <AlertTriangle aria-hidden="true" size={17} />
                <span className="today-row-copy">
                  <strong>{job.title}</strong>
                  <small>{job.error || job.message || "任务没有完成"}</small>
                </span>
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="today-section">
        <div className="today-section-head">
          <h2>最近草稿</h2>
          <Link href="/writer">写一稿 <ChevronRight size={15} aria-hidden="true" /></Link>
        </div>
        <div className="today-card">
          {libraryLoading ? (
            <p className="today-empty">正在读取草稿…</p>
          ) : libraryError ? (
            <div className="today-row is-danger">
              <AlertTriangle aria-hidden="true" size={17} />
              <span className="today-row-copy"><strong>草稿读取失败</strong><small>{libraryError}</small></span>
              <button className="btn compact" onClick={() => void refreshLibrary({ force: true })} type="button">重试</button>
            </div>
          ) : library?.recentDrafts.length ? library.recentDrafts.slice(0, 3).map((draft) => (
            <Link className="today-row" href={buildWriterDraftHref(draft)} key={draft.id}>
              <FileText aria-hidden="true" size={17} />
              <span className="today-row-copy">
                <strong>{draft.title || "未命名草稿"}</strong>
                <small>{draft.targetType === "project" ? draft.projectName : draft.accountName} · {relativeTime(draft.updatedAt)}</small>
              </span>
              <ArrowRight aria-hidden="true" size={16} />
            </Link>
          )) : (
            <p className="today-empty">还没有草稿，从热榜挑一条“用它写”。</p>
          )}
        </div>
      </section>
    </div>
  );
}

function TaskCard({ jobs, onCancel }: { jobs: JobRecord[]; onCancel?: (jobId: string) => Promise<JobRecord> }) {
  const primary = jobs[0];
  if (!primary) {
    return (
      <section className="today-task is-idle" aria-live="polite">
        <span className="today-task-icon" aria-hidden="true"><Check size={16} strokeWidth={2.6} /></span>
        <div>
          <strong>后台空闲</strong>
          <small>采集、转写和写作会在 Mac 上继续跑，这里实时显示。</small>
        </div>
      </section>
    );
  }
  const progress = Math.max(0, Math.min(100, Math.round(primary.progress)));
  return (
    <section className="today-task" aria-live="polite">
      <div className="today-task-head">
        <strong>后台任务 {jobs.length} 个在跑</strong>
        {onCancel ? <button type="button" onClick={() => void onCancel(primary.id)}>停止</button> : null}
      </div>
      <div className="today-task-line">
        <span>{primary.title}</span>
        <span>{primary.status === "queued" ? "排队中" : `${progress}%`}</span>
      </div>
      <span className="today-task-rail" aria-label={`任务进度 ${progress}%`}>
        <span style={{ transform: `scaleX(${progress / 100})` }} />
      </span>
      <small className="today-task-detail">{primary.message}</small>
      {jobs.slice(1, 3).map((job) => (
        <div className="today-task-line is-secondary" key={job.id}>
          <span>{job.title}</span>
          <span>{job.status === "queued" ? "排队中" : `${Math.round(job.progress)}%`}</span>
        </div>
      ))}
    </section>
  );
}

/** 先用热榜页留下的缓存秒开，再后台补一次。 */
function useTopHotlist() {
  const [snapshot, setSnapshot] = useState<DouyinHotlistResponse | null>(() => getCachedDouyinHotlist({ window: HOTLIST_WINDOW }));
  const [loading, setLoading] = useState(!snapshot);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    getDouyinHotlist({ window: HOTLIST_WINDOW })
      .then((next) => { if (!ignore) { setSnapshot(next); setError(""); } })
      .catch((reason) => { if (!ignore) setError(reason instanceof Error ? reason.message : "读取热榜失败，请稍后重试"); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, []);

  const items = [...(snapshot?.items ?? [])].sort((left, right) => right.heatScore - left.heatScore).slice(0, 5);
  return { items, total: snapshot?.items.length ?? 0, loading, error };
}

function connectionLabel(connection: ReturnType<typeof useRemoteStatus>["connection"]) {
  if (connection === "online") return "Mac 在线";
  if (connection === "degraded") return "部分可用";
  if (connection === "offline") return "Mac 离线";
  return "正在连接";
}

function formatCheckedAt(value?: string) {
  if (!value) return "刚刚";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function relativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta) || delta < 0) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
