"use client";

import { useRef } from "react";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ModalBackdrop } from "@/components/ModalBackdrop";

export function ConfirmDialog({
  body,
  busy = false,
  cancelLabel = "取消",
  confirmLabel = "确认",
  title,
  onCancel,
  onConfirm
}: {
  body: ReactNode;
  busy?: boolean;
  cancelLabel?: string;
  confirmLabel?: string;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalBackdrop
      disabled={busy}
      onClose={onCancel}
      initialFocusRef={confirmButtonRef}
      aria-labelledby="confirm-dialog-title"
      className="modal-panel confirm-panel"
    >
        <div className="confirm-dialog-body">
          <div className="confirm-dialog-icon" aria-hidden="true">
            <AlertTriangle aria-hidden="true" size={20} />
          </div>
          <div>
            <h2 id="confirm-dialog-title">{title}</h2>
            <div className="confirm-dialog-content">{body}</div>
          </div>
        </div>
        <div className="confirm-dialog-actions">
          <button className="btn" disabled={busy} onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          <button className="btn danger" disabled={busy} onClick={onConfirm} ref={confirmButtonRef} type="button">
            {busy ? "删除中…" : confirmLabel}
          </button>
        </div>
    </ModalBackdrop>
  );
}
