"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ImageControlPopover } from "./ImageControlPopover";
import { Sparkles, ScanLine } from "lucide-react";
import { useTasks } from "@/components/TaskProvider";
import { getJob } from "@/lib/client";
import { imagePromptAssistResultSchema } from "@/lib/image-prompt-assist-types";
import { imageMentionPattern, imagePromptLabel } from "@/lib/image-mentions";

export function ImagePromptAssist({ prompt, referenceIds, disabled, onApply }: { prompt: string; referenceIds: string[]; disabled: boolean; onApply: (text: string) => void }) {
  const search = useSearchParams();
  const { jobs, startTask, cancelTask } = useTasks();
  const [id, setId] = useState(search.get("assistId") || "");
  const assistId = search.get("assistId") || "";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ text: string; fallback: boolean; fallbackReason?: string } | null>(null);
  const original = useRef("");
  const lock = useRef(false);
  const job = jobs.find((item) => item.id === id);
  const active = pending || job?.status === "queued" || job?.status === "running";
  const status = job?.status;
  const kind = job?.kind;
  const savedResult = job?.result;
  useEffect(() => {
    setId(assistId); setResult(null); setError(""); original.current = "";
  }, [assistId]);
  useEffect(() => {
    if (!id || (status && status !== "completed")) return;
    let cancelled = false;
    const request = savedResult !== undefined ? Promise.resolve({ job: { kind, status, result: savedResult } }) : getJob(id);
    void request.then(({ job: full }) => {
      if (cancelled || full.status !== "completed") return;
      if (full.kind !== "image-prompt-assist") throw new Error("这不是提示词建议任务。");
      setResult(imagePromptAssistResultSchema.parse(full.result));
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读取建议失败，请重试。"); });
    return () => { cancelled = true; };
  }, [id, status, kind, savedResult]);
  async function start(mode: "polish" | "suggest") {
    if (lock.current || active) return;
    lock.current = true; setPending(true); setError(""); setResult(null); original.current = prompt;
    try { setId((await startTask({ kind: "image-prompt-assist", input: { prompt, mode } })).id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "提交失败，请重试。"); }
    finally { lock.current = false; setPending(false); }
  }
  return <div className="image-prompt-assist" aria-busy={active}>
    <div className="image-assist-actions" title="使用 GPT-6 Sol，推理强度 high（高），与生图输出质量无关。">
      {result ? <ImageControlPopover label="AI 助手结果" trigger={<><Sparkles size={16} />建议结果</>} width="composer" autoOpen disabled={disabled || active}>{(close) => <div className="image-assist-preview"><p>{imagePromptLabel(result.text)}</p>{result.fallback ? <small>{result.fallbackReason || "本次使用备用模型生成。"}</small> : null}{original.current && original.current !== prompt ? <small>原文已有修改，采用会替换当前提示词。</small> : null}<div className="image-assist-actions"><button className="btn small" type="button" disabled={disabled} onClick={() => { if (Array.from(result.text.matchAll(imageMentionPattern())).some((match) => !referenceIds.includes(match[2]))) { setError("建议中的参考图已移除，请重新润色。"); return; } onApply(result.text); setResult(null); close(); }}>采用</button><button className="btn small" type="button" onClick={() => { setResult(null); close(); }}>保留原文</button></div></div>}</ImageControlPopover> : <><button className="btn image-assist-direct" type="button" disabled={disabled || !prompt.trim()} aria-label="AI 润色" onClick={() => void start("polish")}><Sparkles size={16} />AI 润色</button><button className="btn image-assist-direct" type="button" disabled={disabled || !prompt.trim()} aria-label="构图建议" onClick={() => void start("suggest")}><ScanLine size={16} />构图建议</button></>}
      {active ? <><span role="status">正在思考…</span><button className="btn small" type="button" disabled={pending} onClick={() => void cancelTask(id).catch((reason) => setError(reason instanceof Error ? reason.message : "取消失败"))}>取消</button></> : null}</div>
    {error || job?.status === "failed" || job?.status === "interrupted" ? <p className="error" role="alert">{error || job?.error || "任务已中断，请重新尝试。"}</p> : null}

  </div>;
}
