type DialogOptions = {
  onClose: () => void;
  disabled?: boolean;
  initialFocus?: HTMLElement | null;
  returnFocus?: HTMLElement | null;
  branches?: (HTMLElement | null)[];
};

type DialogEntry = {
  panel: HTMLElement;
  options: () => DialogOptions;
  previous: HTMLElement | null;
};

const dialogs: DialogEntry[] = [];
let previousOverflow = "";
let previousOverflowPriority = "";
const focusableSelector = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"], summary';

function topDialog() {
  return dialogs.at(-1);
}

function visible(element: HTMLElement) {
  return !element.closest('[hidden], [inert]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden";
}

function focusScopes(entry: DialogEntry) {
  return [entry.panel, ...(entry.options().branches || []).filter((item): item is HTMLElement => Boolean(item))];
}

function containsFocus(entry: DialogEntry, node: Node) {
  return focusScopes(entry).some((scope) => scope.contains(node));
}

function focusableElements(entry: DialogEntry) {
  return [...new Set(focusScopes(entry).flatMap((scope) => Array.from(scope.querySelectorAll<HTMLElement>(focusableSelector))))]
    .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && visible(element))
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

function focusPanel(entry: DialogEntry) {
  const initial = entry.options().initialFocus;
  const target = initial && entry.panel.contains(initial) && !initial.matches(":disabled") && visible(initial)
    ? initial : entry.panel;
  target.focus({ preventScroll: true });
}

function onFocusIn(event: FocusEvent) {
  const entry = topDialog();
  if (entry && event.target instanceof Node && !containsFocus(entry, event.target)) focusPanel(entry);
}

function onKeyDown(event: KeyboardEvent) {
  const entry = topDialog();
  if (!entry || event.defaultPrevented || event.isComposing) return;
  if (event.key === "Escape") {
    // Native popovers own their Escape light-dismiss; let them close before the modal.
    if (event.target instanceof Element && event.target.closest("[popover]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!entry.options().disabled) entry.options().onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusableElements(entry);
  const current = document.activeElement;
  const index = elements.findIndex((element) => element === current);
  // 显式处理面板焦点、隐藏控件及正数 tabindex 的顺序。
  event.preventDefault();
  const next = index < 0 ? (event.shiftKey ? elements.length - 1 : 0)
    : (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
  (elements[next] || entry.panel).focus();
}

/** 为现有弹窗外壳共享生命周期；回调实时读取，重绘时不重新抢焦点。 */
export function mountDialog(panel: HTMLElement, options: () => DialogOptions) {
  const entry: DialogEntry = {
    panel,
    options,
    previous: options().returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  };
  if (!dialogs.length) {
    previousOverflow = document.body.style.getPropertyValue("overflow");
    previousOverflowPriority = document.body.style.getPropertyPriority("overflow");
    document.body.style.setProperty("overflow", "hidden");
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
  }
  // 子组件的 layout effect 可能先于父组件注册。
  const childIndex = dialogs.findIndex((item) => panel.contains(item.panel));
  dialogs.splice(childIndex < 0 ? dialogs.length : childIndex, 0, entry);
  if (topDialog() === entry) focusPanel(entry);
  return {
    close() {
      if (topDialog() === entry && !options().disabled) options().onClose();
    },
    dispose() {
      const index = dialogs.indexOf(entry);
      if (index < 0) return;
      const wasTop = topDialog() === entry;
      dialogs.splice(index, 1);
      // 底层弹窗先卸载时，保留有效的焦点返回链。
      for (const item of dialogs) {
        if (item.previous && containsFocus(entry, item.previous)) item.previous = entry.previous;
      }
      if (!dialogs.length) {
        document.body.style.setProperty("overflow", previousOverflow, previousOverflowPriority);
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("focusin", onFocusIn);
      }
      if (!wasTop) return;
      const parent = topDialog();
      if (entry.previous?.isConnected && visible(entry.previous) && (!parent || containsFocus(parent, entry.previous))) {
        entry.previous.focus({ preventScroll: true });
      } else if (parent) focusPanel(parent);
    }
  };
}
