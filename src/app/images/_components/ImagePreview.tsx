"use client";
import { useEffect, useRef, useState } from "react";
import Lightbox, { type ControllerRef } from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Download from "yet-another-react-lightbox/plugins/download";
import { ArrowUp, ChevronDown, Check, RectangleHorizontal } from "lucide-react";
import { ImageControlPopover } from "./ImageControlPopover";
import { imageFileUrl, type ImageFile } from "@/lib/image-generation-types";
import { imageModelLabel, imageProfileForModel, imageRatioForSize, imageRatios, imageSizeForProfile, resolutionLabels } from "@/lib/image-profile-options";
import type { useImageWorkbench } from "../_hooks/useImageWorkbench";
export type PreviewImage = ImageFile & { recordId?: string };
export function ImagePreview({ image, images = [image], workbench: w, onClose, drafts, onDraftChange }: { image: PreviewImage; images?: PreviewImage[]; workbench: ReturnType<typeof useImageWorkbench>; onClose: () => void; drafts: Record<string, string>; onDraftChange: (id: string, text: string) => void }) {
  const controller = useRef<ControllerRef>(null);
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".image-edit-lightbox") || target.closest("input, textarea, select, [contenteditable=true], .image-edit-composer, [popover]")) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "ArrowUp") controller.current?.prev();
      else controller.current?.next();
    };
    document.addEventListener("keydown", navigate, true);
    return () => document.removeEventListener("keydown", navigate, true);
  }, []);
  useEffect(() => {
    let start: { x: number; y: number; id: number } | null = null;
    const isBlank = (target: EventTarget | null) => target instanceof Element &&
      Boolean(target.closest(".image-edit-lightbox")) &&
      !target.closest("img, button, a, input, textarea, select, .image-edit-composer, [popover], [role=button]");
    const down = (event: PointerEvent) => {
      start = event.isPrimary && event.button === 0 && isBlank(event.target) ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    };
    const up = (event: PointerEvent) => {
      if (start?.id === event.pointerId && isBlank(event.target) && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) controller.current?.close();
      start = null;
    };
    const cancel = () => { start = null; };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
    };
  }, []);
  const slides = images.some((item) => item.id === image.id) ? images : [image];
  const [index, setIndex] = useState(Math.max(0, slides.findIndex((item) => item.id === image.id)));
  const [profileId, setProfileId] = useState(w.form.profileId || w.config?.defaultProfileId || "default");
  const [size, setSize] = useState(w.form.size);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const current = slides[index] || image;
  const prompt = drafts[current.id] || "";
  const profiles = w.config?.profiles || [];
  const profile = profiles.find((item) => item.id === profileId);
  const ratio = imageRatioForSize(size);
  const disabled = submitting || w.busy || w.uploading;
  return <Lightbox controller={{ ref: controller, closeOnBackdropClick: false }} open close={onClose} index={index} on={{ view: ({ index: next }) => setIndex(next) }} slides={slides.map((item) => ({ src: imageFileUrl(item.id), alt: item.name, download: { url: imageFileUrl(item.id, true), filename: `${item.name}.${item.format}` } }))} plugins={[Zoom, Download]} carousel={{ finite: true }} className="image-edit-lightbox" animation={{ fade: 200, swipe: 220 }} labels={{ Close: "关闭预览", Next: "下一张", Previous: "上一张", "Zoom in": "放大", "Zoom out": "缩小", Download: "下载原图" }} render={{ controls: () => <form className="image-edit-composer" onKeyDown={(event) => { if (event.key !== "Escape" || event.currentTarget.querySelector("[popover]:popover-open")) event.stopPropagation(); }} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onSubmit={async (event) => {
    event.preventDefault(); if (disabled || !prompt.trim()) return;
    setSubmitting(true); setAttempted(true);
    try { if (await w.generateFromImage(current, prompt.trim(), profileId, size, current.recordId)) { onDraftChange(current.id, ""); onClose(); } }
    finally { setSubmitting(false); }
  }}>
    <label htmlFor="image-edit-instruction">基于这张图继续创作</label>
    {slides.length > 1 ? <small aria-live="polite">{index + 1} / {slides.length} · ↑ 上一张 · ↓ 下一张</small> : null}
    <textarea id="image-edit-instruction" placeholder="描述你想修改的地方…" value={prompt} disabled={disabled} onChange={(event) => onDraftChange(current.id, event.target.value)} />
    <div className="image-edit-toolbar">
      <ImageControlPopover label="编辑模型" trigger={<>{profile ? imageModelLabel(profile.model) : "选择模型"}<ChevronDown size={14} /></>} disabled={disabled}>{(close) => <div className="image-control-menu">{[...new Set(profiles.map((item) => item.model))].map((model) => <button key={model} type="button" aria-pressed={model === profile?.model} onClick={() => { const next = imageProfileForModel(profiles, model, profile?.resolution); if (next) { setProfileId(next.id); setSize(imageSizeForProfile(next, ratio)); } close(); }}><span>{imageModelLabel(model)}</span>{model === profile?.model ? <Check size={16} /> : null}</button>)}</div>}</ImageControlPopover>
      <ImageControlPopover label="编辑分辨率" trigger={<>{resolutionLabels[profile?.resolution || "1080p"]}<ChevronDown size={14} /></>} disabled={disabled || profiles.filter((item) => item.model === profile?.model).length < 2}>{(close) => <div className="image-control-menu">{profiles.filter((item) => item.model === profile?.model).map((item) => <button key={item.id} type="button" onClick={() => { setProfileId(item.id); setSize(imageSizeForProfile(item, ratio)); close(); }}>{resolutionLabels[item.resolution || "1080p"]}</button>)}</div>}</ImageControlPopover>
      <ImageControlPopover label="编辑比例" trigger={<><RectangleHorizontal size={16} />{ratio === "auto" ? "自动" : imageRatios.some((item) => item === ratio) ? ratio : "自定义"}</>} width={360} disabled={disabled}>{(close) => <div className="image-ratio-options">{imageRatios.map((value) => { const [x,y] = value === "auto" ? [1, 1] : value.split(":").map(Number); return <button key={value} type="button" aria-label={`编辑比例 ${value === "auto" ? "自动" : value}`} aria-pressed={ratio === value} onClick={() => { setSize(imageSizeForProfile(profile, value)); close(); }}><span style={{ width: x >= y ? 62 : 62*x/y, height: y >= x ? 62 : 62*y/x }}>{value === "auto" ? "自动" : value}</span></button>; })}</div>}</ImageControlPopover>
      <small>生成 1 张 · 原图保留</small><button className="btn primary" type="submit" disabled={disabled || !profile?.configured || !prompt.trim()} aria-label="生成修改后的图片" title={submitting ? "提交中…" : "生成修改后的图片"}><ArrowUp size={20} /></button>
    </div>
    {attempted && w.error ? <p className="error" role="alert">{w.error}</p> : null}
  </form> }} />;
}
