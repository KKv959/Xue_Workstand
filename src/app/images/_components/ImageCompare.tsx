"use client";
/* eslint-disable @next/next/no-img-element -- Compare original local images. */
import { ModalBackdrop } from "@/components/ModalBackdrop";
import { X, Download } from "lucide-react";
import { imageFileUrl, type ImageFile } from "@/lib/image-generation-types";
export default function ImageCompare({ images, onClose }: { images: ImageFile[]; onClose: () => void }) {
  return <ModalBackdrop onClose={onClose} className="modal-panel image-compare" aria-labelledby="image-compare-title"><header className="image-pane-heading"><h2 id="image-compare-title">方案对比 · {images.length} 张</h2><button type="button" className="btn icon" aria-label="关闭对比" onClick={onClose}><X size={18} /></button></header><div className="image-compare-grid">{images.map((image, index) => <figure key={image.id}><img src={imageFileUrl(image.id)} alt={`对比方案 ${index + 1}：${image.name}`} /><figcaption><span>方案 {index + 1}</span><a className="btn small" download href={imageFileUrl(image.id, true)}><Download size={14} />下载</a></figcaption></figure>)}</div></ModalBackdrop>;
}
