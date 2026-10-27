"use client";
import { CircleDot, ChevronDown, X } from "lucide-react";
import type { JobListItem } from "@/lib/types";
import { ImageControlPopover } from "./ImageControlPopover";

export function ImageJobStatus({ jobs, disabled, onCancel }: {
  jobs: JobListItem[];
  disabled: boolean;
  onCancel: (id: string) => void;
}) {
  const active = jobs.filter((job) => job.status === "running" || job.status === "queued");
  if (!active.length) return null;
  const running = active.filter((job) => job.status === "running").length;
  const queued = active.length - running;
  const label = [running ? `${running} 个生成中` : "", queued ? `${queued} 个排队中` : ""].filter(Boolean).join(" · ");
  return <ImageControlPopover label={`图片任务：${label}`} placement="below" width={360} className="image-job-trigger" trigger={<><CircleDot size={15} /><span aria-live="polite">{label}</span><ChevronDown size={13} /></>}>
    {(close) => <div className="image-job-list">
      <header><strong>当前图片任务</strong><button className="btn icon small" type="button" aria-label="收起图片任务" onClick={close}><X size={15} /></button></header>
      <div className="image-job-list-items">{active.map((job) => <section className="image-job-item" key={job.id}>
        <div className="image-job-item-heading"><strong>{job.title}</strong><button className="btn small" type="button" aria-label={`停止任务 ${job.title}`} disabled={disabled} onClick={() => onCancel(job.id)}>停止</button></div>
        <p>{job.status === "queued" ? "排队中，稍后自动开始" : job.message}</p>
        <progress max={100} value={job.progress} aria-label={`${job.title}进度`} />
      </section>)}</div>
      <small>任务结束后自动收起，历史状态可在任务中心查看。</small>
    </div>}
  </ImageControlPopover>;
}
