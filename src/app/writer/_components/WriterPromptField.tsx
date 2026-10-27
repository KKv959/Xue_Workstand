"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { polishWriterPrompt } from "@/lib/client";
import { DEFAULT_REWRITE_PROMPT } from "@/lib/source-extraction";

export function WriterPromptField({ prompt, onChange }: { prompt: string; onChange: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggestion, setSuggestion] = useState<{ original: string; text: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function polish() {
    if (controller.current || !prompt.trim()) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(true); setError(""); setSuggestion(null);
    try {
      const result = await polishWriterPrompt(prompt, current.signal);
      if (!current.signal.aborted) setSuggestion({ original: prompt, text: result.text });
    } catch (reason) {
      if (!current.signal.aborted) setError(reason instanceof Error ? reason.message : "润色失败，请重试。");
    } finally {
      if (controller.current === current) { controller.current = null; setBusy(false); }
    }
  }

  return <div className="writer-field">
    <div className="writer-source-label-row">
      <label htmlFor="writer-prompt">这次想怎么写</label>
      <div className="writer-prompt-actions" aria-busy={busy}>
        <button className="btn small ghost" type="button" disabled={busy || !prompt.trim()} onClick={() => void polish()} title="保留原意，把口语要求整理清楚">
          <Sparkles size={14} aria-hidden="true" />{busy ? "润色中…" : "AI 润色"}
        </button>
        {busy ? <button className="btn small ghost" type="button" onClick={() => { controller.current?.abort(); }}>取消</button> : null}
      </div>
    </div>
    <textarea ref={input} id="writer-prompt" aria-label="写作要求" autoComplete="off" className="writer-textarea main" name="prompt" placeholder={DEFAULT_REWRITE_PROMPT} value={prompt} onChange={(event) => onChange(event.target.value)} />
    <div aria-live="polite">{busy ? <small>正在整理写作要求，原文会保留。</small> : null}</div>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {suggestion ? <section className="writer-prompt-preview" aria-label="润色建议">
      <strong>润色建议</strong>
      <p>{suggestion.text}</p>
      {suggestion.original !== prompt ? <small>要求已有修改，请重新润色以免覆盖新内容。</small> : null}
      <div className="writer-prompt-actions">
        <button className="btn small" type="button" disabled={suggestion.original !== prompt} onClick={() => { onChange(suggestion.text); setSuggestion(null); input.current?.focus(); }}>采用</button>
        <button className="btn small ghost" type="button" onClick={() => { setSuggestion(null); input.current?.focus(); }}>保留原文</button>
      </div>
    </section> : null}
  </div>;
}
