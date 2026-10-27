"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { ModalBackdrop } from "./ModalBackdrop";
import styles from "./NavigationPreferences.module.css";

const STORAGE_KEY = "workbench-navigation-visibility";
type Item = { href: string; label: string; group: string };

export function useNavigationVisibility() {
  const [hidden, setHidden] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const read = () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const value = raw ? JSON.parse(raw) : { schemaVersion: 1, hidden: [] };
        if (value?.schemaVersion !== 1 || !Array.isArray(value.hidden) || !value.hidden.every((item: unknown) => typeof item === "string")) {
          throw new Error("导航偏好格式损坏，请在自定义导航中重新保存。");
        }
        setHidden(value.hidden);
        setError("");
      } catch (error) {
        setError(error instanceof SyntaxError ? "导航偏好格式损坏，请重新保存。" : error instanceof Error ? error.message : "读取导航偏好失败，请检查浏览器存储权限。");
      } finally { setReady(true); }
    };
    read();
    const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) read(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const save = (next: string[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, hidden: next }));
      setHidden(next);
      setError("");
      return true;
    } catch {
      setError("保存导航偏好失败，请允许浏览器使用本地存储后重试。");
      return false;
    }
  };
  return { hidden, error, ready, save };
}

export function NavigationPreferences({ items, hidden, error, ready, onSave }: {
  items: Item[]; hidden: string[]; error: string; ready: boolean; onSave: (hidden: string[]) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  return <>
    <div className={styles.triggerRow}>
      <span>工作空间</span>
      <button type="button" className="btn ghost icon-only compact" aria-label="自定义导航" title="自定义导航" aria-haspopup="dialog" disabled={!ready}
        onClick={() => { setDraft(hidden); setOpen(true); }}>
        <SlidersHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
    {error && !open ? <p className="error" role="alert">{error}</p> : null}
    {open ? <ModalBackdrop className={`modal-panel ${styles.panel}`} aria-labelledby="navigation-preferences-title" initialFocusRef={closeRef} onClose={() => setOpen(false)}>
      <header className={styles.header}>
        <div><h2 id="navigation-preferences-title">自定义导航</h2><p className="subtle">勾选要显示的模块，仅影响当前浏览器。隐藏后可随时恢复。</p></div>
        <button ref={closeRef} className="btn ghost icon-only compact" aria-label="关闭自定义导航" type="button" onClick={() => setOpen(false)}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className={styles.groups}>
        {[...new Set(items.map((item) => item.group))].map((group) => <fieldset key={group} className={styles.group}>
          <legend>{group}</legend>
          {items.filter((item) => item.group === group).map((item) => <label key={item.href} className={styles.option}>
            <span>{item.label}</span>
            <input type="checkbox" checked={!draft.includes(item.href)} onChange={(event) => setDraft(event.target.checked ? draft.filter((href) => href !== item.href) : [...draft, item.href])} />
          </label>)}
        </fieldset>)}
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <footer className={styles.footer}>
        <button type="button" className="btn ghost" onClick={() => setDraft(draft.filter((href) => !items.some((item) => item.href === href)))}>全部显示</button>
        <button type="button" className="btn primary" onClick={() => { if (onSave(draft)) setOpen(false); }}>保存设置</button>
      </footer>
    </ModalBackdrop> : null}
  </>;
}
