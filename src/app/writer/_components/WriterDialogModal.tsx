"use client";

import type { ReactNode } from "react";
import { ModalBackdrop } from "@/components/ModalBackdrop";

type WriterDialogModalProps = {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
  panelClassName?: string;
};

export function WriterDialogModal({
  children,
  labelledBy,
  onClose,
  panelClassName = ""
}: WriterDialogModalProps) {
  return (
    <ModalBackdrop
      onClose={onClose}
      aria-labelledby={labelledBy}
      className={`modal-panel ${panelClassName}`}
    >
        {children}
    </ModalBackdrop>
  );
}
