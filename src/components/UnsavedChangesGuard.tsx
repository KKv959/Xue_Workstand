"use client";

const UNSAVED_CHANGES_SELECTOR = '[data-unsaved-changes="true"]';

export function hasUnsavedChanges() {
  return typeof document !== "undefined" && Boolean(document.querySelector(UNSAVED_CHANGES_SELECTOR));
}

export function confirmDiscardUnsavedChanges(message: string) {
  if (!hasUnsavedChanges()) return true;
  return window.confirm(message);
}
