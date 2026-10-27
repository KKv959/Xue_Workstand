"use client";

import { useEffect, type ReactNode, type RefObject } from "react";
import { Dialog, I18nProvider, Modal, ModalOverlay, type DialogProps } from "react-aria-components";

type ModalBackdropProps = Omit<DialogProps, "children"> & {
  children: ReactNode;
  disabled?: boolean;
  onClose: () => void;
  backdropClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
};

export function ModalBackdrop({
  children,
  disabled = false,
  onClose,
  backdropClassName = "modal-backdrop",
  initialFocusRef,
  ...dialogProps
}: ModalBackdropProps) {
  return (
    <I18nProvider locale="zh-CN">
      <ModalOverlay className={backdropClassName} isOpen isDismissable={!disabled}
        isKeyboardDismissDisabled={disabled} onOpenChange={open => { if (!open && !disabled) onClose(); }}>
        <Modal className="workbench-modal">
          <Dialog {...dialogProps} aria-modal="true">
            <InitialFocus target={initialFocusRef} />
            {children}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </I18nProvider>
  );
}

function InitialFocus({ target }: { target?: RefObject<HTMLElement | null> }) {
  useEffect(() => { target?.current?.focus({ preventScroll: true }); }, [target]);
  return null;
}
