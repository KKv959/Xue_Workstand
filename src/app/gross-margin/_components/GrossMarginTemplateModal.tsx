"use client";

import { useMemo, useState } from "react";
import { Save, X } from "lucide-react";
import { ModalBackdrop } from "@/components/ModalBackdrop";
import {
  renderGrossMarginReviewTemplate,
  type GrossMarginReviewTemplateValues
} from "@/lib/gross-margin-template";
import { GrossMarginTemplateEditor } from "./GrossMarginTemplateEditor";
import type { GrossMarginReviewTemplate } from "@/lib/types";

export function GrossMarginTemplateModal({
  busy,
  platformLabel,
  previewValues,
  template,
  onClose,
  onSave
}: {
  busy: boolean;
  platformLabel: string;
  previewValues: GrossMarginReviewTemplateValues;
  template: GrossMarginReviewTemplate;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(template.content);
  const preview = useMemo(() => {
    try {
      return { text: renderGrossMarginReviewTemplate(draft, previewValues), error: "" };
    } catch (error) {
      return { text: "", error: error instanceof Error ? error.message : "文案模板无法预览" };
    }
  }, [draft, previewValues]);
  const canSave = Boolean(draft.trim()) && !preview.error && !busy;
  const dirty = draft !== template.content;
  const lineCount = useMemo(() => draft.split("\n").filter((line) => line.trim()).length, [draft]);

  function requestClose() {
    if (busy) return;
    if (dirty && !window.confirm("文案模板还有未保存修改，确定关闭吗？")) return;
    onClose();
  }

  return (
    <ModalBackdrop
      disabled={busy}
      onClose={requestClose}
      aria-labelledby="gross-template-modal-title"
      className="modal-panel gross-template-modal"
      data-unsaved-changes={dirty ? "true" : undefined}
    >
        <header className="gross-template-header">
          <div>
            <h2 id="gross-template-modal-title">{platformLabel}文案模板</h2>
            <p className="subtle">
              {lineCount} 行，{template.customized ? "当前使用永久自定义模板" : "当前使用系统默认模板"}
            </p>
          </div>
          <button aria-label="关闭文案模板弹窗" className="btn icon-btn icon-only" disabled={busy} onClick={requestClose} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <div className="gross-template-layout">
          <section className="gross-template-edit-column" aria-label="编辑模板">
            <GrossMarginTemplateEditor value={draft} disabled={busy} onChange={setDraft} />
          </section>

          <aside className="gross-template-preview" aria-label="文案预览">
            <div className="gross-template-preview-head">
              <strong>实时预览</strong>
              <span>{preview.error ? "需修正" : `${countTemplateLines(preview.text)} 行`}</span>
            </div>
            {preview.error ? (
              <p className="gross-template-error" role="alert">
                {preview.error}
              </p>
            ) : (
              <pre>{preview.text}</pre>
            )}
          </aside>
        </div>

        <footer className="button-row gross-template-actions">
          <button
            aria-busy={busy}
            className="btn primary"
            disabled={!canSave}
            onClick={() => void onSave(draft)}
            type="button"
          >
            <Save aria-hidden="true" size={15} />
            {busy ? "保存中" : "保存模板"}
          </button>
        </footer>
    </ModalBackdrop>
  );
}

function countTemplateLines(value: string) {
  return value.split("\n").filter((line) => line.trim()).length;
}
