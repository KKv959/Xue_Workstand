"use client";
/* eslint-disable @next/next/no-img-element -- Uploaded reference thumbnails. */
import { imageFileUrl, type ImageFile } from "@/lib/image-generation-types";
import { ImageControlPopover } from "./ImageControlPopover";
import { ImageLibraryPicker } from "./ImageLibraryPicker";
import { ImagePromptAssist } from "./ImagePromptAssist";
import { useLayoutEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useDialogInteraction } from "@/components/useDialogInteraction";
import { ArrowUp, SlidersHorizontal, Maximize2, Minimize2, Plus, Upload, Images, ChevronDown, Check, RectangleHorizontal, Layers, X, Icon } from "lucide-react";
import { imageModelLabel, imageProfileForModel, imageRatioForSize, imageRatios, imageSizeForProfile, resolutionLabels, type ImageProfile } from "@/lib/image-profile-options";
import type { useImageWorkbench } from "../_hooks/useImageWorkbench";
const ImagePromptEditor = dynamic(() => import("./ImagePromptEditor"), { ssr: false, loading: () => <p role="status">正在加载提示词编辑器…</p> });
const qualities = [{ value: "auto", label: "自动" }, { value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }] as const;
type Workbench = ReturnType<typeof useImageWorkbench>;
export function ImageControls({ workbench: w, onLocate, onUpload, draggedImage }: { draggedImage: ImageFile | null; workbench: Workbench; onUpload: () => void; onLocate: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const composer = useRef<HTMLFormElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const panel = composer.current;
    const workspace = panel?.closest<HTMLElement>(".image-workbench");
    if (!expanded || !panel || !workspace) return;
    const position = () => {
      const rect = workspace.getBoundingClientRect();
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const width = Math.max(0, Math.min(window.innerWidth, rect.right) - left);
      const height = Math.max(0, Math.min(window.innerHeight, rect.bottom) - top);
      panel.style.setProperty("--expanded-center-x", `${(left + width / 2) / zoom}px`);
      panel.style.setProperty("--expanded-center-y", `${(top + height / 2) / zoom}px`);
      panel.style.setProperty("--expanded-width", `${Math.max(0, width / zoom - 32)}px`);
      panel.style.setProperty("--expanded-height", `${height / zoom * .9}px`);
    };
    // A popover backdrop retargets pointer events to the panel itself.
    const outside = (event: MouseEvent) => {
      if (event.target !== panel) return event.target instanceof Node && !panel.contains(event.target);
      const rect = panel.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    let pressedOutside = false;
    const pointerDown = (event: PointerEvent) => { pressedOutside = event.button === 0 && outside(event); };
    const click = (event: MouseEvent) => {
      if (!pressedOutside || !outside(event)) return;
      event.preventDefault(); event.stopPropagation(); setExpanded(false);
    };
    position(); panel.showPopover();
    const observer = new ResizeObserver(position);
    observer.observe(workspace);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("click", click, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("click", click, true);
      if (panel.matches(":popover-open")) panel.hidePopover();
    };
  }, [expanded]);
  useDialogInteraction(composer, { active: expanded, onClose: () => setExpanded(false), returnFocusRef: expandButton });
  const disabled = w.busy || w.uploading;
  const [dragOver, setDragOver] = useState(false);
  const [source, setSource] = useState<"menu" | "library">("menu");
  const [previewRatio, setPreviewRatio] = useState<string | null>(null);
  const selectedProfile = w.config?.profiles.find((profile) => profile.id === (w.form.profileId || "default"));
  const profiles = w.config?.profiles || [];
  const variants = profiles.filter((profile) => profile.model === selectedProfile?.model);
  const ratio = imageRatioForSize(w.form.size);
  function previewReference(id: string) { setExpanded(false); onLocate(id); }
  function chooseProfile(profile: ImageProfile | undefined) {
    if (profile) w.setForm((current) => ({ ...current, profileId: profile.id, size: imageSizeForProfile(profile, imageRatioForSize(current.size)) }));
  }
  const candidates = [...new Map([...w.availableReferences, ...w.recordReferences, ...(w.record?.images || []), ...w.boardRecords.flatMap((record) => record.thumbnail ? [record.thumbnail] : [])].map((image) => [image.id, image])).values()];
  return <form ref={composer} popover={expanded ? "manual" : undefined} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? "展开创作指令" : undefined} tabIndex={expanded ? -1 : undefined} className={`image-composer ${expanded ? "is-expanded" : ""} ${dragOver ? "is-reference-drop" : ""}`} onDragOver={(event) => { if (!disabled && (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("application/x-workbench-image"))) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragOver(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }} onDropCapture={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); if (disabled) return; const id = event.dataTransfer.getData("application/x-workbench-image"); if (id && draggedImage?.id === id) w.addReference(draggedImage); else if (event.dataTransfer.files.length) void w.upload(Array.from(event.dataTransfer.files)); }} onSubmit={async (event) => { event.preventDefault(); if (await w.generate()) setExpanded(false); }} onPaste={(event) => {
    const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void w.upload(files); }
  }}>
    <button ref={expandButton} className="btn icon small image-composer-expand" type="button" aria-label={expanded ? "收起输入框" : "展开输入框"} aria-expanded={expanded} title={expanded ? "收起输入框（Esc）" : "展开输入框"} onClick={() => setExpanded((current) => !current)}>{expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
    {w.references.length ? <div className="image-composer-references" aria-label="本次参考图">{w.references.map((image) => <div className="image-composer-reference" key={image.id}><button type="button" aria-label={`预览参考图 ${image.name}`} onClick={() => previewReference(image.id)}><img src={imageFileUrl(image.id)} alt={image.name} /></button><button className="btn icon small" type="button" aria-label={`移除参考图 ${image.name}`} disabled={disabled} onClick={() => w.removeReference(image.id)}><X size={14} /></button></div>)}</div> : null}
    {dragOver ? <div className="image-reference-drop-hint">松开，添加为参考图</div> : null}
    <ImagePromptEditor draggedImage={draggedImage} onPasteFiles={(files) => w.upload(files, false)} onError={w.fail} value={w.form.prompt} references={candidates} disabled={disabled} onLocate={previewReference} onReference={(image) => w.addReference(image, false)} onChange={(prompt) => w.setForm((current) => ({ ...current, prompt }))} />
    <div className="image-composer-bottom">
      <fieldset className="image-quick-settings" disabled={disabled}>
        <ImageModelPicker workbench={w} placement="above" />
        <ImageControlPopover label="添加参考图" trigger={<Plus size={18} />} className="icon" width={source === "library" ? 560 : 300} disabled={disabled || w.form.referenceIds.length >= 6}>{(close) => source === "library" ? <><button className="btn ghost small" type="button" onClick={() => setSource("menu")}>返回添加方式</button><ImageLibraryPicker workbench={w} onChoose={(image) => { if (w.addReference(image)) { close(); setSource("menu"); } }} /></> : <div className="image-control-menu"><button type="button" onClick={() => { close(); onUpload(); }}><Upload size={20} /><span><strong>上传文件</strong><small>从电脑添加参考图片</small></span></button><button type="button" onClick={() => setSource("library")}><Images size={20} /><span><strong>从作品库选择</strong><small>使用已生成的图片</small></span></button></div>}</ImageControlPopover>
        <ImageControlPopover label="分辨率" trigger={<>{selectedProfile ? resolutionLabels[selectedProfile.resolution || "1080p"] : "分辨率"}<ChevronDown size={13} /></>} disabled={disabled || variants.length < 2} width={210}>{(close) => <div className="image-control-menu">{variants.map((profile) => <button type="button" aria-pressed={profile.id === selectedProfile?.id} key={profile.id} onClick={() => { chooseProfile(profile); close(); }}><span>{resolutionLabels[profile.resolution || "1080p"]}</span>{profile.id === selectedProfile?.id ? <Check size={16} /> : null}</button>)}</div>}</ImageControlPopover>
        <ImageControlPopover label="画面比例" trigger={<><RectangleHorizontal size={16} />{ratio === "auto" ? "自动" : imageRatios.some((r) => r === ratio) ? ratio : "自定义"}</>} width={540} disabled={disabled}>{(close) => <div className="image-ratio-picker">
          <div className="image-ratio-options" onMouseLeave={() => setPreviewRatio(null)}>{imageRatios.map((value) => { const [x, y] = value === "auto" ? [1, 1] : value.split(":").map(Number); return <button type="button" key={value} aria-label={`比例 ${value === "auto" ? "自动" : value}`} aria-pressed={ratio === value} onMouseEnter={() => setPreviewRatio(value)} onFocus={() => setPreviewRatio(value)} onClick={() => { w.setForm((current) => ({ ...current, size: imageSizeForProfile(selectedProfile, value) })); setPreviewRatio(null); close(); }}><span style={{ width: x >= y ? 62 : 62 * x / y, height: y >= x ? 62 : 62 * y / x }}>{value === "auto" ? "自动" : value}</span></button>; })}</div>
          <div className="image-ratio-preview" aria-hidden="true">{(previewRatio || ratio) === "auto" ? <Icon size={72} strokeWidth={1.75} absoluteStrokeWidth iconNode={[["rect", { x: "7", y: "7", width: "10", height: "10", rx: "2", key: "frame" }], ["path", { d: "M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3", key: "corners" }]]} /> : <div style={{ aspectRatio: (previewRatio || ratio).replace(":", "/"), width: Number((previewRatio || ratio).split(":")[0]) >= Number((previewRatio || ratio).split(":")[1]) ? "100%" : undefined, height: Number((previewRatio || ratio).split(":")[0]) < Number((previewRatio || ratio).split(":")[1]) ? "100%" : undefined }} />}</div>
        </div>}</ImageControlPopover>
        <ImageControlPopover label="本次张数" trigger={<><Layers size={16} />{w.form.count} 张</>} width={230} disabled={disabled}>{(close) => <><p className="image-control-caption">{w.multiModels.length ? "每个模型生成张数" : "本次生成张数"}</p><div className="image-segment-options">{[1, 2, 3, 4].map((count) => <button key={count} type="button" aria-label={`${count} 张`} aria-pressed={w.form.count === count} onClick={() => { w.setForm((current) => ({ ...current, count })); close(); }}>{count}</button>)}</div></>}</ImageControlPopover>
        <ImageControlPopover label="更多生成设置" trigger={<SlidersHorizontal size={17} />} className="icon" width="composer" disabled={disabled}>{() => <div className="image-expanded-settings">
          <section><h3>自定义尺寸</h3><ImageSettings workbench={w} /></section>
          <section><h3>输出质量</h3><div className="image-segment-options">{qualities.map((option) => <button key={option.value} type="button" aria-pressed={w.form.quality === option.value} onClick={() => w.setForm((current) => ({ ...current, quality: option.value }))}>{option.label}</button>)}</div><p>默认自动，按画面需求平衡细节与速度。</p></section>
        </div>}</ImageControlPopover>
      </fieldset>
      <ImagePromptAssist prompt={w.form.prompt} referenceIds={w.form.referenceIds} disabled={disabled} onApply={(prompt) => w.setForm((current) => ({ ...current, prompt }))} />
      <div className="image-submit">{w.active ? <small role="status">生成中，可继续提交</small> : null}<button className="btn primary image-generate-button" type="submit" aria-label="开始生成" aria-busy={w.busy} title={w.active ? "继续提交新的生成任务" : "开始生成"} disabled={disabled || w.detailLoading || !selectedProfile?.configured || !w.form.prompt.trim()}><ArrowUp size={19} /><span className="sr-only">{w.busy ? "提交中" : "生成"}</span></button></div>
    </div>
    {w.multiModels.length > 1 ? <small className="image-batch-hint">{w.multiModels.length} 个模型 × {w.form.count} 张，共 {w.multiModels.length * w.form.count} 张</small> : null}
    {expanded && w.error ? <p className="error image-expanded-error" role="alert">{w.error}</p> : null}
    {w.uploading ? <small role="status">正在保存参考图…</small> : null}
    {selectedProfile && !selectedProfile.configured ? <p className="error" role="alert">{selectedProfile.model === "ChatGPT 订阅生图" ? "请在本机 AI 模型配置连接 ChatGPT 订阅（Codex）；云端暂不支持订阅生图。" : "所选图片服务未配置，请检查对应模型的 API 配置。"}</p> : null}
  </form>;
}
export function ImageSettings({ workbench: w }: { workbench: Workbench }) {
  const [align, setAlign] = useState(true);
  const dimensions = w.form.size === "auto" ? [1024, 1024] : w.form.size.split("x").map(Number);
  function dimension(axis: number, value: string, snap = false) {
    const next = [...dimensions]; const n = Number(value);
    next[axis] = snap && align ? Math.round(n / 16) * 16 : n;
    w.setForm((current) => ({ ...current, size: next.join("x") }));
  }
  return <div className="image-size-inline">
    <div className="image-dimensions">{["宽", "高"].map((label, axis) => <label className="field" key={label}>{label}（px）<input type="number" min={256} max={4096} step={1} disabled={w.form.size === "auto"} value={dimensions[axis] || ""} onChange={(event) => dimension(axis, event.target.value)} onBlur={(event) => dimension(axis, event.target.value, true)} /></label>)}</div>
    <label className="image-align-toggle"><input type="checkbox" checked={align} onChange={(event) => setAlign(event.target.checked)} />16 倍数对齐</label>
  </div>;
}

export function ImageModelPicker({ workbench: w, placement = "below" }: { workbench: Workbench; placement?: "above" | "below" }) {
  const profiles = w.config?.profiles || [];
  const selected = profiles.find((profile) => profile.id === (w.form.profileId || "default"));
  const models = [...new Set(profiles.map((profile) => profile.model))];
  const [query, setQuery] = useState("");
  const multiple = w.multiModels.length > 0;
  return <div className={placement === "above" ? "image-composer-model" : "image-model-picker"}><ImageControlPopover label={placement === "above" ? "生成模型" : "模型"} placement={placement} width={340} trigger={<><span>模型</span>{multiple ? `${w.multiModels.length} 个模型` : selected ? imageModelLabel(selected.model) : "读取配置…"}<ChevronDown size={14} /></>} disabled={w.busy || w.uploading}>{(close) => <div className="image-control-menu image-model-menu"><input className="image-model-search" aria-label="搜索模型" placeholder="搜索模型…" value={query} onChange={(event) => setQuery(event.target.value)} /><label className="image-multi-toggle"><input type="checkbox" role="switch" checked={multiple} onChange={(event) => w.setMultiModels(event.target.checked && selected ? [selected.model] : [])} />多模型生成</label>{models.filter((model) => imageModelLabel(model).toLowerCase().includes(query.toLowerCase())).map((model) => {
    const checked = multiple ? w.multiModels.includes(model) : selected?.model === model;
    return <button key={model} type="button" aria-pressed={checked} onClick={() => {
      if (multiple) { w.setMultiModels((current) => current.includes(model) ? current.length > 1 ? current.filter((item) => item !== model) : current : [...current, model]); return; }
      const profile = imageProfileForModel(profiles, model, selected?.resolution);
      if (profile) w.setForm((current) => ({ ...current, profileId: profile.id, size: imageSizeForProfile(profile, imageRatioForSize(current.size)) }));
      close();
    }}><span><strong>{imageModelLabel(model)}</strong><small>{profiles.filter((item) => item.model === model).map((item) => resolutionLabels[item.resolution || "1080p"]).join(" / ")} · 支持参考图编辑</small></span><span className={`image-model-check ${checked ? "is-checked" : ""}`}>{checked ? <Check size={14} /> : null}</span></button>;
  })}<p className="image-model-note">{multiple ? `每个模型各生成 ${w.form.count} 张，共 ${w.multiModels.length * w.form.count} 张。未支持的分辨率使用该模型可用档位。` : "选择模型后，分辨率选项会随之更新。"}</p></div>}</ImageControlPopover></div>;
}
