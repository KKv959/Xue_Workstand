"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function WriterActionMenu({ label, icon, children, text, disabled = false }: { label: string; icon: ReactNode; children: ReactNode; text?: string; disabled?: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => panel.current?.hidePopover();
    const onScroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) dismiss(); };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", onScroll, true); };
  }, [open]);
  function close() { panel.current?.hidePopover(); trigger.current?.focus(); }
  function show() {
    const anchor = trigger.current;
    const surface = panel.current;
    if (!anchor || !surface) return;
    surface.showPopover();
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const rect = anchor.getBoundingClientRect();
    const left = text ? rect.left / zoom : rect.right / zoom - surface.offsetWidth;
    const below = rect.bottom / zoom + 6;
    const top = below + surface.offsetHeight <= window.innerHeight / zoom - 8 ? below : rect.top / zoom - surface.offsetHeight - 6;
    surface.style.left = `${Math.max(8, Math.min(left, window.innerWidth / zoom - surface.offsetWidth - 8))}px`;
    surface.style.top = `${Math.max(8, top)}px`;
    surface.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
  }
  return <>
    <button ref={trigger} disabled={disabled} className={`btn ghost ${text ? "compact" : "icon-only"} writer-tool`} type="button" aria-label={label} title={label} aria-expanded={open} aria-controls={id}
      onClick={() => open ? close() : show()} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); show(); } }}>{text}{icon}</button>
    <div id={id} ref={panel} popover="auto" className="writer-action-menu" role="group" aria-label={label} onToggle={(event) => setOpen(event.newState === "open")}
      onClickCapture={(event) => { if ((event.target as HTMLElement).closest("button:not(:disabled)")) close(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const buttons = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") || []);
          const index = buttons.indexOf(document.activeElement as HTMLElement);
          buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>{children}</div>
  </>;
}
