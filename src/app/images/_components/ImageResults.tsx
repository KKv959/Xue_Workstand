"use client";
/* eslint-disable @next/next/no-img-element -- Saved local image results. */
import { useEffect, useRef, useState } from "react";
import { Download, Copy, Check, RotateCcw, Pencil, ImagePlus, LoaderCircle, Trash2 } from "lucide-react";
import { getImageGenerationRecord } from "@/lib/client";
import { imagePromptLabel } from "@/lib/image-mentions";
import { imageModelLabel } from "@/lib/image-profile-options";
import type { JobListItem } from "@/lib/types";
import { imageFileUrl, type ImageFile, type ImageGenerationRecord, type ImageGenerationSummary } from "@/lib/image-generation-types";

type ResultProps = { deleting: boolean; onDelete: (id: string) => void; onImagesAvailable: (id: string, images: ImageFile[]) => void; record: ImageGenerationRecord | null; onPreview: (image: ImageFile, recordId?: string) => void; onReproduce: (id: string) => void; onReference: (images: ImageFile[]) => void; disabled: boolean; onDragImage: (image: ImageFile | null) => void; previewOpen: boolean };
function ResultImage({ image, onPreview, onDragImage, previewOpen }: Pick<ResultProps, "onPreview" | "onDragImage" | "previewOpen"> & { image: ImageFile }) {
  const [dismissed, setDismissed] = useState(false);
  function open() { setDismissed(true); onPreview(image); }
  return <article className={`image-node-media ${dismissed || previewOpen ? "is-actions-dismissed" : ""}`} onPointerEnter={() => { if (!previewOpen) setDismissed(false); }} onKeyDown={(event) => { if (event.key === "Tab") setDismissed(false); }} draggable onDragStart={(event) => { setDismissed(true); event.dataTransfer.setData("application/x-workbench-image", image.id); event.dataTransfer.effectAllowed = "copy"; onDragImage(image); }} onDragEnd={() => onDragImage(null)}>
    <button className="image-result-open" type="button" aria-label={`放大并编辑 ${image.name}`} onClick={open}><img src={imageFileUrl(image.id)} alt={image.name} draggable={false} loading="lazy" /></button>
    <div className="image-node-hover-actions"><button className="btn" type="button" onClick={open}><Pencil size={16} />编辑图片</button><a className="btn" href={imageFileUrl(image.id, true)} download><Download size={16} />下载</a></div>
  </article>;
}
function CopyPrompt({ prompt, fallback }: { prompt?: string; fallback: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reset.current) clearTimeout(reset.current); }, []);
  async function copy() {
    if (!prompt) return;
    setError("");
    try {
      await navigator.clipboard.writeText(imagePromptLabel(prompt));
      setCopied(true);
      if (reset.current) clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); setError("复制失败，请允许浏览器访问剪贴板后重试。"); }
  }
  return <><button type="button" className={`image-result-prompt image-copy-prompt ${copied ? "is-copied" : ""}`} disabled={!prompt} aria-label="复制完整提示词" onClick={() => void copy()}><span>{imagePromptLabel(prompt || fallback)}</span><span className="image-copy-feedback" aria-live="polite">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : prompt ? "点击复制" : "读取中…"}</span></button>{error ? <p className="error" role="alert">{error}</p> : null}</>;
}
function ResultGroup({ summary, record, task, onImagesAvailable, ...props }: ResultProps & { summary: ImageGenerationSummary; task?: JobListItem }) {
  const container = useRef<HTMLElement>(null);
  const [detail, setDetail] = useState<ImageGenerationRecord | null>(null);
  const [error, setError] = useState("");
  const selected = record?.id === summary.id;
  const cached = detail?.updatedAt === summary.updatedAt;
  useEffect(() => {
    if (selected || cached) return;
    let alive = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void getImageGenerationRecord(summary.id).then((data) => { if (alive) { setDetail(data.record); setError(""); } }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "图片读取失败，请刷新重试。"); });
    }, { rootMargin: "100px" });
    if (container.current) observer.observe(container.current);
    return () => { alive = false; observer.disconnect(); };
  }, [selected, cached, summary.id, summary.updatedAt]);
  const full = record?.id === summary.id ? record : detail;
  const visible = full?.images || (summary.thumbnail ? [summary.thumbnail] : []);
  useEffect(() => {
    if (full?.images) onImagesAvailable(summary.id, full.images);
  }, [full?.images, onImagesAvailable, summary.id]);
  const pending = task?.status === "running" || task?.status === "queued";
  const remaining = pending ? Math.max(0, summary.count - visible.length) : Math.max(0, summary.imageCount - visible.length);
  const [width, height] = summary.size.split("x").map(Number);
  const ratio = width > 0 && height > 0 ? `${width} / ${height}` : "1 / 1";
  return <section ref={container} className="image-result-group" data-record-id={summary.id} aria-label={summary.title}>
    <div className="image-result-context"><CopyPrompt prompt={full?.prompt} fallback={summary.title} /><div className="image-result-meta"><span>{imageModelLabel(summary.model)}</span></div><div className="image-result-actions"><button className="btn small" type="button" disabled={props.disabled} title="将本次提示词、参数和参考图填入输入框" onClick={() => props.onReproduce(summary.id)}><RotateCcw size={14} />复现</button><button className="btn small" type="button" disabled={props.disabled || !visible.length || visible.length < summary.imageCount} title="将本组生成图片加入参考" onClick={() => props.onReference(visible)}><ImagePlus size={14} />加入参考</button><button className="btn small image-result-delete" type="button" aria-label={`删除生成记录 ${summary.title}`} title={pending ? "生成中，请先停止任务" : "删除本组生成记录，可撤销；原图保留"} disabled={props.deleting || pending} onClick={() => props.onDelete(summary.id)}><Trash2 size={14} />删除</button></div>{error ? <p className="error" role="alert">{error}</p> : null}{task?.error ? <p className="error" role="alert">{task.error}</p> : null}</div>
    <div className="image-result-pictures" style={{ "--result-ratio": ratio } as React.CSSProperties}>
      {visible.map((image) => <ResultImage key={image.id} image={image} {...props} onPreview={(image) => props.onPreview(image, summary.id)} />)}
      {Array.from({ length: remaining }, (_, index) => <div key={`pending-${visible.length + index}`} className="image-result-pending" role="status"><LoaderCircle size={20} /><span>{pending ? task.status === "queued" ? "排队中" : "生成中" : "读取图片…"}</span>{pending ? <small>{task.progress}%</small> : null}</div>)}
    </div>
  </section>;
}
export function ImageResults({ records, record, loading, active, jobs, children, submissionKey, jump, ...props }: ResultProps & { records: ImageGenerationSummary[]; loading: boolean; active: boolean; jobs: JobListItem[]; submissionKey: string; jump: { id: string; version: number } | null; children?: React.ReactNode }) {
  const candidates = jump && record?.id === jump.id && !records.some((item) => item.id === record.id)
    ? [...records, { ...record, title: imagePromptLabel(record.prompt), imageCount: record.images.length, thumbnail: record.images[0] }]
    : records;
  const results = candidates.filter((item) => item.id === jump?.id || item.imageCount > 0 || jobs.some((job) => job.id === item.id && ["running", "queued", "failed", "cancelled", "interrupted"].includes(job.status))).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  const feed = useRef<HTMLDivElement>(null);
  const followLatest = useRef(!jump);
  const followTarget = useRef(Boolean(jump));
  useEffect(() => { followTarget.current = Boolean(jump); }, [jump]);
  const latest = results.at(-1);
  const latestStatus = jobs.find((job) => job.id === latest?.id)?.status;
  const latestKey = latest ? `${latest.id}:${latest.imageCount}:${latestStatus || ""}` : "";
  useEffect(() => {
    if (jump) { followLatest.current = false; return; }
    followLatest.current = true;
    const element = feed.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [submissionKey, latestKey, active, jump]);
  useEffect(() => {
    const element = feed.current;
    if (!element) return;
    // Lazy record details and decoded images can change row height after submission.
    // Follow those changes until the user deliberately scrolls back through history.
    let frame = 0;
    const align = () => {
      const target = jump && Array.from(element.querySelectorAll<HTMLElement>("[data-record-id]")).find((row) => row.dataset.recordId === jump.id);
      if (target && followTarget.current) {
        element.scrollTo({ top: element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top - 66, behavior: "instant" });
      } else if (followLatest.current) element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    };
    const target = jump && Array.from(element.querySelectorAll<HTMLElement>("[data-record-id]")).find((row) => row.dataset.recordId === jump.id);
    target?.classList.add("is-jump-target");
    const timeout = window.setTimeout(() => target?.classList.remove("is-jump-target"), 1800);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    });
    observer.observe(element);
    Array.from(element.children).forEach((child) => observer.observe(child));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout); target?.classList.remove("is-jump-target"); };
  }, [records, record, jump]);
  return <div ref={feed} className="image-results" aria-label="生成结果" aria-busy={loading} onWheel={() => { followLatest.current = false; followTarget.current = false; }} onTouchStart={() => { followLatest.current = false; followTarget.current = false; }} onPointerDown={() => { followLatest.current = false; followTarget.current = false; }} onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End", " "].includes(event.key)) followLatest.current = false; followTarget.current = false; }}>
    {!results.length ? <div className="image-results-empty"><ImagePlus size={30} /><h2>{loading ? "正在读取作品…" : active ? "正在生成图片…" : "从一个想法开始"}</h2><p>在下方描述画面、添加参考图，生成的图片会显示在这里。</p></div> : results.map((summary) => <ResultGroup key={summary.id} summary={summary} record={record} task={jobs.find((job) => job.id === summary.id)} {...props} />)}
    {children}
  </div>;
}
