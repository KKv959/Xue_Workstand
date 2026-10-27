"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Columns2, LayoutGrid, Plus, RefreshCw, Scan } from "lucide-react";
import { type ImageFile, type ImageGenerationSummary } from "@/lib/image-generation-types";
import { useImageWorkbench } from "./_hooks/useImageWorkbench";
import { ImageControls, ImageModelPicker } from "./_components/ImageControls";
import { ImageGallery } from "./_components/ImageGallery";
import { ImageJobStatus } from "./_components/ImageJobStatus";
import { ImageResults } from "./_components/ImageResults";
import type { PreviewImage } from "./_components/ImagePreview";
const ImagePreview = dynamic(() => import("./_components/ImagePreview").then((module) => module.ImagePreview), { ssr: false });
const ImageCompare = dynamic(() => import("./_components/ImageCompare"), { ssr: false });

export default function ImagesPage() {
  return <Suspense fallback={<div className="empty-state-panel" role="status">正在加载生图工作台…</div>}><ImageWorkbench /></Suspense>;
}
function ImageWorkbench() {
  const w = useImageWorkbench();
  const [jump, setJump] = useState<{ id: string; version: number; submission: string } | null>(null);
  const [view, setView] = useState<"canvas" | "gallery">("canvas");
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const [previewImages, setPreviewImages] = useState<PreviewImage[]>([]);
  const loadedImages = useRef(new Map<string, ImageFile[]>());
  const rememberImages = useCallback((id: string, images: ImageFile[]) => { loadedImages.current.set(id, images); }, []);
  function openResultPreview(image: ImageFile, recordId?: string) {
    const images = [...w.boardRecords].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).flatMap((record) => (loadedImages.current.get(record.id) || (record.thumbnail ? [record.thumbnail] : [])).map((image) => ({ ...image, recordId: record.id })));
    const selected = { ...image, recordId };
    setPreviewImages([...new Map([...images, selected].map((item) => [item.id, item])).values()]);
    setPreview(selected);
  }
  function openReferencePreview(image: ImageFile) { setPreviewImages([...new Map([...w.references, ...w.recordReferences, image].map((item) => [item.id, item])).values()]); setPreview(image); }
  const [previewDrafts, setPreviewDrafts] = useState<Record<string, string>>({});
  const dirty = w.dirty || Object.values(previewDrafts).some((text) => text.trim());
  const [compared, setCompared] = useState<ImageFile[]>([]);
  const [comparing, setComparing] = useState(false);
  const [draggedImage, setDraggedImage] = useState<ImageFile | null>(null);
  const workbenchElement = useRef<HTMLElement>(null);
  const composerDock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dock = composerDock.current;
    if (!dock) return;
    const observer = new ResizeObserver(() => { if (!dock.querySelector(".is-expanded")) workbenchElement.current?.style.setProperty("--composer-clearance", `${dock.getBoundingClientRect().height + 24}px`); });
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  function statusFor(record: ImageGenerationSummary) {
    const task = w.jobs.find((entry) => entry.id === record.id);
    if (task?.status === "running") return `生成中 · 已保存 ${record.imageCount}/${record.count} 张`;
    if (task?.status === "queued") return "排队中";
    if (task?.status === "failed") return `生成失败 · 已保存 ${record.imageCount} 张`;
    if (task?.status === "cancelled") return `已停止 · 已保存 ${record.imageCount} 张`;
    if (task?.status === "interrupted") return `已中断 · 已保存 ${record.imageCount} 张`;
    return record.imageCount === record.count ? `${record.imageCount} 张已保存` : `${record.imageCount}/${record.count} 张 · 未完成`;
  }
  function select(id: string) { setJump({ id, version: Date.now(), submission: w.submissionKey }); w.select(id); setView("canvas"); }
  function toggleCompare(image: ImageFile) {
    if (compared.some((item) => item.id === image.id)) setCompared((items) => items.filter((item) => item.id !== image.id));
    else if (compared.length < 4) setCompared((items) => [...items, image]);
    else w.fail(new Error("最多同时对比 4 张图片，请先取消一张。"));
  }
  const list = view === "gallery" ? w.records : w.boardRecords;
  const total = view === "gallery" ? w.total : w.boardTotal;
  return <div className="page images-page" data-unsaved-changes={dirty ? "true" : undefined}>
    <h1 className="sr-only">生图工作台</h1>
    <section ref={workbenchElement} className={`image-workbench ${view === "canvas" ? "is-creation-view" : ""}`}>
      <header className="image-workbench-toolbar"><div className="image-view-switch" role="group" aria-label="工作区视图"><button className="btn" type="button" aria-pressed={view === "canvas"} onClick={() => setView("canvas")}><Scan size={16} />图片创作</button><button className="btn" type="button" aria-pressed={view === "gallery"} onClick={() => setView("gallery")}><LayoutGrid size={16} />作品图库 <small>{w.total}</small></button></div><div className="image-toolbar-actions"><ImageJobStatus jobs={w.batchJobs.length ? w.batchJobs : w.job ? [w.job] : []} disabled={w.busy} onCancel={(id) => { void w.cancel(id); }} /><button className="btn" type="button" disabled={w.busy || w.uploading} onClick={() => { if (w.newRecord()) { setPreviewDrafts({}); setView("canvas"); } }}><Plus size={16} />新建创作</button>{compared.length ? <button className="btn small" type="button" onClick={() => setComparing(true)} disabled={compared.length < 2}><Columns2 size={15} />对比 {compared.length ? `${compared.length}/4` : "方案"}</button> : null}{compared.length ? <button className="btn small" type="button" onClick={() => setCompared([])}>清空选择</button> : null}<button className="btn icon" type="button" aria-label="刷新生成记录" onClick={() => { void w.refresh(); void w.refreshBoard(); }}><RefreshCw size={15} /></button></div></header>
      {w.deletion ? <div className="image-deletion-feedback" role="status">{w.deletion.message}{w.deletion.operationId ? <button className="btn small" type="button" disabled={w.deleting} onClick={() => void w.undoDelete()}>撤销删除</button> : null}</div> : null}
      {w.error ? <div className="error image-workbench-error" role="alert">{w.error}</div> : null}

      <div className="image-workspace">
        <div className="image-workspace-main">
          {view === "canvas" ? <>
          <ImageModelPicker workbench={w} />
          <ImageResults deleting={w.deleting} onDelete={(id) => { void w.deleteRecords({ action: "delete", id }); }} jump={jump?.submission === w.submissionKey ? jump : null} submissionKey={w.submissionKey} previewOpen={Boolean(preview)} jobs={w.jobs} records={w.boardRecords} record={w.record} loading={w.boardLoading} active={w.active} disabled={w.busy || w.uploading} onReproduce={(id) => { void w.reproduce(id); }} onReference={w.addResultReferences} onPreview={openResultPreview} onImagesAvailable={rememberImages} onDragImage={setDraggedImage}>{list.length < total ? <div className="image-more-records"><button className="btn small" type="button" disabled={w.moreLoading} onClick={() => void w.loadMore(true)}>{w.moreLoading ? "加载中…" : `加载更多 · ${list.length}/${total}`}</button></div> : null}</ImageResults></> : <ImageGallery records={w.records} loading={w.loading} selectedId={w.id} compared={compared} onSelect={select} onCompare={toggleCompare} deleting={w.deleting} onDelete={(id) => { void w.deleteRecords({ action: "delete", id }); }} onClearFailed={() => { void w.deleteRecords({ action: "clear-failed" }); }} statusFor={statusFor} />}
          {view === "gallery" && list.length < total ? <div className="image-more-records"><button className="btn small" type="button" disabled={w.moreLoading} onClick={() => void w.loadMore(false)}>{w.moreLoading ? "加载中…" : `加载更多 · ${list.length}/${total}`}</button></div> : null}
        </div>
      </div>
      <div ref={composerDock} className="image-composer-dock" hidden={view !== "canvas"}><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => { void w.upload(Array.from(event.target.files || [])); event.target.value = ""; }} />
      <ImageControls draggedImage={draggedImage} onUpload={() => fileInput.current?.click()} workbench={w} onLocate={(id) => { const image = [...w.availableReferences, ...w.recordReferences].find((item) => item.id === id); if (image) openReferencePreview(image); }} /></div>
    </section>
    {preview ? <ImagePreview drafts={previewDrafts} onDraftChange={(id, text) => setPreviewDrafts((current) => ({ ...current, [id]: text }))} workbench={w} image={preview} images={previewImages} onClose={() => setPreview(null)} /> : null}
    {comparing ? <ImageCompare images={compared} onClose={() => setComparing(false)} /> : null}
  </div>;
}
