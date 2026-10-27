"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { mountDialog } from "./dialog-interaction";

type DialogInteractionOptions = {
  onClose: () => void;
  disabled?: boolean;
  active?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  branchRefs?: RefObject<HTMLElement | null>[];
};

export function useDialogInteraction(rootRef: RefObject<HTMLElement | null>, options: DialogInteractionOptions) {
  const latest = useRef(options);
  const instance = useRef<ReturnType<typeof mountDialog> | null>(null);
  useLayoutEffect(() => { latest.current = options; });
  const active = options.active ?? true;
  useLayoutEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    const panel = root?.matches('[role="dialog"], dialog') ? root
      : root?.querySelector<HTMLElement>('[role="dialog"], dialog');
    if (!panel) return;
    const dialog = mountDialog(panel, () => ({
      ...latest.current,
      initialFocus: latest.current.initialFocusRef?.current,
      returnFocus: latest.current.returnFocusRef?.current,
      branches: latest.current.branchRefs?.map((ref) => ref.current)
    }));
    instance.current = dialog;
    return () => {
      instance.current = null;
      dialog.dispose();
    };
  }, [active, rootRef]);
  return useCallback(() => instance.current?.close(), []);
}
