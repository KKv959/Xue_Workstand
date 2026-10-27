"use client";
/* eslint-disable @next/next/no-img-element -- Local saved image previews. */
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getImageGenerationRecord } from "@/lib/client";
import { imageFileUrl, type ImageFile } from "@/lib/image-generation-types";
import type { useImageWorkbench } from "../_hooks/useImageWorkbench";
export function ImageLibraryPicker({ workbench: w, onChoose }: { workbench: ReturnType<typeof useImageWorkbench>; onChoose: (image: ImageFile) => void }) {
  const [images, setImages] = useState<ImageFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return <div className="image-library-picker">
    <header>{images ? <button className="btn icon small" type="button" aria-label="返回作品列表" onClick={() => setImages(null)}><ArrowLeft size={16} /></button> : null}<strong>{images ? "选择一张图片" : "从作品库选择"}</strong><small>添加为参考图</small></header>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {loading ? <p role="status">正在读取图片…</p> : <div className="image-library-picker-grid">{images ? images.map((image) => <button type="button" key={image.id} aria-label={`引用 ${image.name}`} onClick={() => onChoose(image)}><img src={imageFileUrl(image.id)} alt={image.name} /><span>{image.name}</span></button>) : w.records.filter((record) => record.imageCount > 0).map((record) => <button type="button" key={record.id} aria-label={`查看作品 ${record.title}`} onClick={async () => {
      setLoading(true); setError("");
      try { setImages((await getImageGenerationRecord(record.id)).record.images); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "作品读取失败，请重试。"); }
      finally { setLoading(false); }
    }}>{record.thumbnail ? <img src={imageFileUrl(record.thumbnail.id)} alt="" loading="lazy" /> : null}<span>{record.title}</span><small>{record.imageCount} 张</small></button>)}</div>}
    {!images && !loading && !w.records.some((record) => record.imageCount > 0) ? <p>暂无已生成作品。</p> : null}
    {!images && w.records.length < w.total ? <button className="btn small" type="button" disabled={w.moreLoading} onClick={() => void w.loadMore()}>{w.moreLoading ? "加载中…" : "加载更多作品"}</button> : null}
  </div>;
}
