"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Shared non-modal control surface: native light-dismiss, keyboard access and animated exit. */
export function ImageControlPopover({ label, trigger, children, width = 280, placement = "above", className = "", disabled = false, autoOpen = false }: {
  label: string; trigger: ReactNode; children: (close: () => void) => ReactNode;
  width?: number | "composer"; placement?: "above" | "below"; className?: string; disabled?: boolean; autoOpen?: boolean;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const position = useCallback(() => {
    const anchor = button.current;
    const surface = panel.current;
    if (!anchor || !surface) return;
    const measured = (width === "composer" ? anchor.closest("form") : anchor)?.getBoundingClientRect();
    if (!measured) return;
    // Fixed top-layer popovers still inherit the root zoom, while DOMRect and
    // viewport measurements are already expressed in visual pixels. Convert
    // them back to the page coordinate space before assigning CSS positions.
    const rootZoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const rect = {
      top: measured.top / rootZoom,
      bottom: measured.bottom / rootZoom,
      left: measured.left / rootZoom,
      width: measured.width / rootZoom
    };
    const viewportWidth = window.innerWidth / rootZoom;
    const viewportHeight = window.innerHeight / rootZoom;
    surface.style.width = `${Math.min(width === "composer" ? rect.width : width, viewportWidth - 24)}px`;
    surface.style.maxHeight = `${Math.min(560, viewportHeight - 24)}px`;
    const above = Math.max(0, rect.top - 22);
    const below = Math.max(0, viewportHeight - rect.bottom - 22);
    const preferredSpace = placement === "above" ? above : below;
    const oppositeSpace = placement === "above" ? below : above;
    const resolvedPlacement = preferredSpace < surface.offsetHeight && oppositeSpace > preferredSpace
      ? placement === "above" ? "below" : "above"
      : placement;
    surface.dataset.placement = resolvedPlacement;
    surface.style.maxHeight = `${Math.max(0, Math.min(560, resolvedPlacement === "above" ? above : below))}px`;
    const size = { width: surface.offsetWidth, height: surface.offsetHeight };
    surface.style.left = `${Math.max(12, Math.min(rect.left, viewportWidth - size.width - 12))}px`;
    const top = resolvedPlacement === "above" ? rect.top - size.height - 10 : rect.bottom + 10;
    surface.style.top = `${Math.max(12, Math.min(top, viewportHeight - size.height - 12))}px`;
  }, [width, placement]);
  useEffect(() => {
    if (autoOpen) { panel.current?.showPopover(); position(); }
  }, [autoOpen, position]);
  const close = () => { panel.current?.hidePopover(); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, position]);
  return <>
    <button ref={button} type="button" className={`btn image-control-trigger ${className}`} aria-label={label} aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => { if (open) close(); else { panel.current?.showPopover(); position(); } }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); panel.current?.showPopover(); position(); panel.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus(); }
    }}>{trigger}</button>
    <div ref={panel} id={id} popover="auto" className={`image-control-popover ${width === "composer" ? "image-control-wide" : ""}`} data-placement={placement} role="group" aria-label={label} onToggle={(event) => setOpen(event.newState === "open")}>
      {children(close)}
    </div>
  </>;
}
