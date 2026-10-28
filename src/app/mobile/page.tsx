"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileText,
  Flame,
  Loader2,
  PenLine,
  RefreshCw,
  Video
} from "lucide-react";
import { useLibrary } from "@/components/LibraryProvider";
import { useRemoteStatus } from "@/components/RemoteStatusProvider";
import { useOptionalTasks } from "@/components/TaskProvider";
import { buildWriterDraftHref } from "@/lib/draft-links";
import type { JobRecord } from "@/lib/types";

export default function MobileHomePage() {
  const { library, loading: libraryLoading, error: libraryError, refresh: refreshLibrary } = useLibrary();
  const tasks = useOptionalTasks();
  const remote = useRemoteStatus();
  const primaryJob = tasks?.activeJobs[0] || null;
  const failedJobs = tasks?.recentJobs.filter((job) => job.status === "failed" || job.status === "interrupted") || [];

  return (
    <div className="mobile-home page">
      <section className={`mobile-connection-card ${remote.connection}`} aria-live="polite">
        <div className="mobile-connection-copy">
          <span className="mobile-eyebrow">私人远程后台</span>
          <h1>{connectionTitle(remote.connection)}</h1>
          <p>{connectionMessage(remote)}</p>
        </div>
        <button
          aria-busy={remote.connection === "checking"}
          aria-label="重新检查后台状态"
          className="btn icon-only"
          disabled={remote.connection === "checking"}
          onClick={() => void remote.refresh({ fresh: true })}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={18} />
        </button>
      </section>

      <section className="mobile-section">
        <div className="mobile-section-heading">
          <div>
            <span className="mobile-eyebrow">当前执行</span>
            <h2>任务进度</h2>
          </div>
          <span className={`status-pill ${primaryJob ? "pending" : "completed"}`}>
            {primaryJob ? `${tasks?.activeJobs.length || 0} 个进行中` : "空闲"}
          </span>
        </div>
        {primaryJob ? <ActiveJobCard job={primaryJob} onCancel={tasks?.cancelTask} /> : (
          <div className="mobile-empty-card">
            <CheckCircle2 aria-hidden="true" size={22} />
            <div>
              <strong>没有正在执行的任务</strong>
              <span>采集、转写和写作任务会继续在 MacBook 后台运行。</span>
            </div>
          </div>
        )}
      </section>

      <section className="mobile-section">
        <div className="mobile-section-heading">
          <div>
            <span className="mobile-eyebrow">快速开始</span>
            <h2>常用操作</h2>
          </div>
        </div>
        <div className="mobile-quick-grid">
          <QuickAction href="/douyin-hotlist" icon={Flame} title="查看热榜" detail="发现正在起量的视频" />
          <QuickAction href="/library" icon={BookOpen} title="账号与转写" detail="采集、转写和编辑文稿" />
          <QuickAction href="/writer" icon={PenLine} title="新建写作" detail="结合风格与素材生成文案" />
          <QuickAction href="/tools" icon={Video} title="链接工具" detail="处理单条视频链接" />
        </div>
      </section>

      <section className="mobile-section">
        <div className="mobile-section-heading">
          <div>
            <span className="mobile-eyebrow">最近工作</span>
            <h2>草稿</h2>
          </div>
          <Link className="mobile-text-link" href="/writer">
            全部 <ArrowRight aria-hidden="true" size={15} />
          </Link>
        </div>
        {libraryLoading ? (
          <div className="mobile-empty-card">
            <Loader2 aria-hidden="true" className="spin" size={22} />
            <span>正在读取草稿…</span>
          </div>
        ) : libraryError ? (
          <div className="mobile-alert-card">
            <AlertTriangle aria-hidden="true" size={20} />
            <div>
              <strong>草稿读取失败</strong>
              <span>{libraryError}</span>
            </div>
            <button className="btn compact" onClick={() => void refreshLibrary({ force: true })} type="button">
              重试
            </button>
          </div>
        ) : library?.recentDrafts.length ? (
          <div className="mobile-list">
            {library.recentDrafts.slice(0, 4).map((draft) => (
              <Link className="mobile-list-row" href={buildWriterDraftHref(draft)} key={draft.id}>
                <span className="mobile-list-icon"><FileText aria-hidden="true" size={18} /></span>
                <span className="mobile-list-copy">
                  <strong>{draft.title || "未命名草稿"}</strong>
                  <small>{draft.targetType === "project" ? draft.projectName : draft.accountName} · {relativeTime(draft.updatedAt)}</small>
                </span>
                <ArrowRight aria-hidden="true" size={17} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="mobile-empty-card">
            <FileText aria-hidden="true" size={22} />
            <div>
              <strong>还没有草稿</strong>
              <span>从写作页生成第一版内容。</span>
            </div>
          </div>
        )}
      </section>

      {failedJobs.length ? (
        <section className="mobile-section">
          <div className="mobile-section-heading">
            <div>
              <span className="mobile-eyebrow">需要处理</span>
              <h2>失败和中断</h2>
            </div>
            <span className="status-pill failed">{failedJobs.length}</span>
          </div>
          <div className="mobile-list">
            {failedJobs.slice(0, 3).map((job) => (
              <Link className="mobile-list-row danger" href={job.href || "/mobile"} key={job.id}>
                <span className="mobile-list-icon"><AlertTriangle aria-hidden="true" size={18} /></span>
                <span className="mobile-list-copy">
                  <strong>{job.title}</strong>
                  <small>{job.message || job.error || "任务没有完成"}</small>
                </span>
                <ArrowRight aria-hidden="true" size={17} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ActiveJobCard({
  job,
  onCancel
}: {
  job: JobRecord;
  onCancel?: (jobId: string) => Promise<JobRecord>;
}) {
  return (
    <article className="mobile-active-job">
      <div className="mobile-active-job-top">
        <span className="mobile-list-icon active"><Loader2 aria-hidden="true" size={18} /></span>
        <div className="mobile-list-copy">
          <strong>{job.title}</strong>
          <small>{job.message}</small>
        </div>
        <strong className="mobile-job-percent">{Math.max(0, Math.min(100, job.progress))}%</strong>
      </div>
      <span className="mobile-progress" aria-label={`任务进度 ${job.progress}%`}>
        <span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
      </span>
      {onCancel ? (
        <button className="btn compact" onClick={() => void onCancel(job.id)} type="button">
          停止任务
        </button>
      ) : null}
    </article>
  );
}

function QuickAction({
  detail,
  href,
  icon: Icon,
  title
}: {
  detail: string;
  href: string;
  icon: typeof Flame;
  title: string;
}) {
  return (
    <Link className="mobile-quick-card" href={href}>
      <span className="mobile-quick-icon"><Icon aria-hidden="true" size={21} /></span>
      <strong>{title}</strong>
      <small>{detail}</small>
      <ArrowRight aria-hidden="true" className="mobile-quick-arrow" size={16} />
    </Link>
  );
}

function connectionTitle(connection: ReturnType<typeof useRemoteStatus>["connection"]) {
  if (connection === "online") return "后台在线";
  if (connection === "degraded") return "后台部分可用";
  if (connection === "offline") return "后台离线";
  return "正在连接后台";
}

function connectionMessage(remote: ReturnType<typeof useRemoteStatus>) {
  if (remote.connection === "online") {
    return `版本 ${remote.status?.app.version || "—"} · ${formatCheckedAt(remote.status?.checkedAt)}`;
  }
  if (remote.connection === "degraded") return "工作台可访问，部分采集或生成能力需要处理。";
  if (remote.connection === "offline") return remote.error;
  return "正在确认 MacBook 和本地服务状态。";
}

function formatCheckedAt(value?: string) {
  if (!value) return "刚刚检查";
  return `检查于 ${new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
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
