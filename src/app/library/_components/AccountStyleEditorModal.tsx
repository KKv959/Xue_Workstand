"use client";

import { memo } from "react";
import { Save, Sparkles } from "lucide-react";
import { LibraryEditorModal } from "./LibraryEditorModal";

type AccountStyleEditorModalProps = {
  busy: string;
  styleDraft: string;
  styleProgress: number;
  styleStage: string;
  unsavedChanges: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onGenerateStyle: () => void;
  onSaveStyle: () => void;
};

export const AccountStyleEditorModal = memo(function AccountStyleEditorModal({
  busy,
  styleDraft,
  styleProgress,
  styleStage,
  unsavedChanges,
  onChange,
  onClose,
  onGenerateStyle,
  onSaveStyle
}: AccountStyleEditorModalProps) {
  const handleClose = () => {
    if (busy) return;
    if (unsavedChanges && !window.confirm("账号风格卡还有未保存修改，确定关闭吗？")) return;
    onClose();
  };
  return (
    <LibraryEditorModal labelledBy="library-style-modal-title" disabled={Boolean(busy)} unsavedChanges={unsavedChanges} onClose={handleClose}>
      <div className="modal-header">
        <h2 id="library-style-modal-title">账号风格卡</h2>
        <button className="btn" disabled={Boolean(busy)} onClick={handleClose} type="button">
          关闭
        </button>
      </div>
      <div className="modal-editor">
        <textarea
          aria-label="账号风格卡"
          disabled={Boolean(busy)}
          autoComplete="off"
          name="accountStyle"
          value={styleDraft}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className="button-row">
          <button className="btn progress-button" disabled={busy === "style"} onClick={onGenerateStyle} type="button">
            <span className="progress-button-fill" style={{ transform: `scaleX(${busy === "style" ? styleProgress / 100 : 0})` }} />
            <span className="progress-button-content">
              <Sparkles aria-hidden="true" size={16} />
              {busy === "style" ? `重新归纳中 ${styleProgress}%` : "重新归纳"}
            </span>
          </button>
          <button className="btn primary" disabled={busy === "save-style" || busy === "style"} onClick={onSaveStyle} type="button">
            <Save aria-hidden="true" size={16} />
            保存
          </button>
        </div>
        <p className="subtle">按全部原文重新归纳适用写法，复用未变化的分析；成功后保留旧卡历史。</p>
        {busy === "style" ? <p className="subtle">{styleStage}</p> : null}
      </div>
    </LibraryEditorModal>
  );
});
