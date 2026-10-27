"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { History, Save } from "lucide-react";
import type { TranscriptVersion } from "@/lib/types";
import { LibraryEditorModal } from "./LibraryEditorModal";

type TranscriptEditorModalProps = {
  activeTranscript: string;
  busy: string;
  restoring: boolean;
  versions: TranscriptVersion[];
  onChange: (value: string) => void;
  onClose: () => void;
  onRestore: (versionId: string) => void;
  onSave: () => void;
};

export const TranscriptEditorModal = memo(function TranscriptEditorModal({
  activeTranscript,
  busy,
  restoring,
  versions,
  onChange,
  onClose,
  onRestore,
  onSave
}: TranscriptEditorModalProps) {
  const [selectedVersionId, setSelectedVersionId] = useState(versions[0]?.id || "");
  const initialTranscriptRef = useRef(activeTranscript);
  const dirty = activeTranscript !== initialTranscriptRef.current;
  const disabled = restoring || busy === "save-transcript";
  const handleClose = useCallback(() => {
    if (disabled) return;
    if (dirty && !window.confirm("转写稿还有未保存修改，确定关闭吗？")) return;
    onClose();
  }, [disabled, dirty, onClose]);

  useEffect(() => {
    if (!versions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(versions[0]?.id || "");
    }
  }, [selectedVersionId, versions]);

  return (
    <LibraryEditorModal
      labelledBy="library-transcript-modal-title"
      panelClassName="transcript-editor-modal"
      unsavedChanges={dirty}
      disabled={disabled}
      onClose={handleClose}
    >
      <div className="modal-header">
        <h2 id="library-transcript-modal-title">转写稿全文</h2>
        <button className="btn" disabled={disabled} onClick={handleClose} type="button">
          关闭
        </button>
      </div>
      <div className="modal-editor">
        <textarea
          aria-label="转写稿全文"
          disabled={disabled}
          autoComplete="off"
          name="transcript"
          value={activeTranscript}
          onChange={(event) => onChange(event.target.value)}
          placeholder="暂无转写稿…"
        />
        {versions.length ? (
          <div className="transcript-history-toolbar">
            <div className="field">
              <label htmlFor="transcript-history-version">历史版本</label>
              <WorkbenchSelect aria-label="历史版本"
                id="transcript-history-version"
                onValueChange={(value) => setSelectedVersionId(value)}
                value={selectedVersionId}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {formatVersionLabel(version)}
                  </option>
                ))}
              </WorkbenchSelect>
            </div>
            <button
              className="btn"
              disabled={!selectedVersionId || restoring || busy === "save-transcript"}
              onClick={() => onRestore(selectedVersionId)}
              type="button"
            >
              <History aria-hidden="true" size={16} />
              {restoring ? "恢复中…" : "恢复版本"}
            </button>
          </div>
        ) : null}
        <div className="button-row">
          <button
            className="btn primary"
            disabled={busy === "save-transcript"}
            onClick={onSave}
            type="button"
          >
            <Save aria-hidden="true" size={16} />
            保存转写稿
          </button>
        </div>
      </div>
    </LibraryEditorModal>
  );
});

function formatVersionLabel(version: TranscriptVersion) {
  const date = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(version.createdAt));
  return `${date} · ${version.preview || "空白版本"}`;
}
