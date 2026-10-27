"use client";

import { useEffect, useState } from "react";
import { invalidateAccountDetail } from "@/lib/detail-cache";
import { updateWriterPreference } from "@/lib/client";

export function WriterPreference({ draftId, disabled, onSaved }: { draftId: string; disabled: boolean; onSaved: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<{ draftId: string; id: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { setText(""); setMessage(""); }, [draftId]);
  async function update(undo: boolean) {
    setPending(true);
    try {
      const result = await updateWriterPreference(undo && saved
        ? { action: "undo", draftId: saved.draftId, preferenceId: saved.id }
        : { action: "remember", draftId, text });
      if (result.reference.targetType === "account") invalidateAccountDetail(result.reference.platform, result.reference.accountId);
      setSaved(undo ? null : { draftId, id: result.preferenceId });
      setMessage(undo ? "已撤销这条偏好。" : "已记住，之后为这个博主新建稿件时生效。当前稿件继续保留原风格快照。");
      setText("");
      await onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存偏好失败，请重试。"); }
    finally { setPending(false); }
  }
  return <section className="writer-revision-composer" aria-label="写作偏好" aria-busy={pending}>
    <label className="writer-field">
      <span>长期写作偏好</span>
      <textarea className="writer-textarea revision" value={text} maxLength={600} disabled={disabled || pending}
        onChange={event => setText(event.target.value)} placeholder="例如：开头先讲具体事件，少用总结式开场。" />
    </label>
    <div className="writer-revision-actions">
      <span>用于当前风格的后续新稿</span>
      <button className="btn compact" type="button" disabled={!draftId || !text.trim() || disabled || pending} onClick={() => void update(false)}>{pending ? "保存中…" : "记住偏好"}</button>
      {saved?.draftId === draftId ? <button className="btn secondary" type="button" disabled={disabled || pending} onClick={() => void update(true)}>撤销上次记住</button> : null}
    </div>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
