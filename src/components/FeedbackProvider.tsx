"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

export type FeedbackTone = "success" | "info" | "warning" | "error";

type FeedbackAction = {
  label: string;
  href?: string;
  onClick?: () => void;
};

export type FeedbackInput = {
  tone?: FeedbackTone;
  title?: string;
  message: string;
  action?: FeedbackAction;
  durationMs?: number;
};

type FeedbackToast = Required<Pick<FeedbackInput, "tone" | "message" | "durationMs">> &
  Omit<FeedbackInput, "tone" | "message" | "durationMs"> & {
    id: string;
  };

type FeedbackContextValue = {
  notify: (input: FeedbackInput) => void;
  dismiss: (id: string) => void;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);
const DEFAULT_TOAST_DURATION_MS = 5000;

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<FeedbackToast[]>([]);
  const lastToastRef = useRef<{ key: string; at: number } | null>(null);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((input: FeedbackInput) => {
    const message = input.message.trim();
    if (!message) return;

    const tone = input.tone || "info";
    const key = `${tone}:${input.title || ""}:${message}`;
    const now = Date.now();
    if (lastToastRef.current?.key === key && now - lastToastRef.current.at < 350) return;
    lastToastRef.current = { key, at: now };

    const toast: FeedbackToast = {
      id: `${now}-${Math.random().toString(36).slice(2)}`,
      tone,
      title: input.title,
      message,
      action: input.action,
      durationMs: input.durationMs || DEFAULT_TOAST_DURATION_MS
    };
    setToasts((current) => [toast, ...current].slice(0, 3));
  }, []);

  const value = useMemo(() => ({ notify, dismiss }), [dismiss, notify]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <FeedbackToasts toasts={toasts} onDismiss={dismiss} />
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error("useFeedback must be used inside FeedbackProvider");
  return context;
}

function FeedbackToasts({
  toasts,
  onDismiss
}: {
  toasts: FeedbackToast[];
  onDismiss: (id: string) => void;
}) {
  if (!toasts.length) return null;

  return (
    <div className="toast-stack feedback-toast-stack" aria-live="polite" aria-label="状态提醒">
      {toasts.map((toast) => (
        <FeedbackToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function FeedbackToastCard({ toast, onDismiss }: { toast: FeedbackToast; onDismiss: (id: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const [closing, setClosing] = useState(false);
  const remainingMsRef = useRef(toast.durationMs);
  const startedAtRef = useRef(Date.now());
  const Icon = getToastIcon(toast.tone);

  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(() => onDismiss(toast.id), 180);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    if (paused) return;
    startedAtRef.current = Date.now();
    const timeout = window.setTimeout(close, remainingMsRef.current);
    return () => {
      window.clearTimeout(timeout);
      remainingMsRef.current = Math.max(0, remainingMsRef.current - (Date.now() - startedAtRef.current));
    };
  }, [close, paused]);

  return (
    <section
      className={`workbench-toast ${toast.tone} ${closing ? "closing" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      data-paused={paused || undefined}
      role={toast.tone === "error" ? "alert" : "status"}
      style={{ "--toast-duration": `${toast.durationMs}ms` } as CSSProperties}
    >
      <Icon aria-hidden="true" size={18} />
      <div className="workbench-toast-copy">
        <strong>{toast.title || getToastTitle(toast.tone)}</strong>
        <span>{toast.message}</span>
        {toast.action ? (
          toast.action.href ? (
            <Link className="workbench-toast-link" href={toast.action.href} onClick={close}>
              {toast.action.label}
            </Link>
          ) : (
            <button
              className="workbench-toast-link as-button"
              onClick={() => {
                toast.action?.onClick?.();
                close();
              }}
              type="button"
            >
              {toast.action.label}
            </button>
          )
        ) : null}
      </div>
      <button className="workbench-toast-close" aria-label="关闭状态提醒" onClick={close} type="button">
        <X aria-hidden="true" size={14} />
      </button>
      <span className="workbench-toast-progress" aria-hidden="true" />
    </section>
  );
}

function getToastIcon(tone: FeedbackTone) {
  if (tone === "success") return CheckCircle2;
  if (tone === "warning") return AlertTriangle;
  if (tone === "error") return XCircle;
  return Info;
}

function getToastTitle(tone: FeedbackTone) {
  if (tone === "success") return "已完成";
  if (tone === "warning") return "需要注意";
  if (tone === "error") return "操作失败";
  return "状态更新";
}
