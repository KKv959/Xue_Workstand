import type * as ReactType from "react";
import { NEWSNOW_BRIDGE_CHANNEL, NEWSNOW_BRIDGE_VERSION, type NewsNowWorkbenchState } from "./newsnow";
import { NEWSNOW_LAYOUT_KEY, moveNewsNowCard, readNewsNowLayout, refreshNewsNowSources, type NewsNowLayout } from "./newsnow-workbench-state";

type Source = { name: string; title?: string };
type SourceResult = { id: string; status: string; updatedTime: number; items: unknown[]; fallbackReason?: string };
type NewsNowApi = {
  Card: ReactType.ComponentType<{ id: string }>;
  sources: Record<string, Source>;
  columns: { hottest: { sources: string[] } };
  cache: Map<string, SourceResult>;
  queryClient: { setQueryData: (key: string[], value: SourceResult) => void };
  request: (url: string, options: { signal: AbortSignal }) => Promise<SourceResult>;
  icons: Record<"grip" | "hide" | "show" | "close" | "reset" | "check", string>;
};

type DragSession = {
  id: string; pointerId: number; x: number; y: number; offsetX: number; offsetY: number;
  ghost: HTMLElement | null; frame: number; started: boolean; before: NewsNowLayout; detach: () => void;
};
type Position = { left: number; top: number };

// The fixed NewsNow adapter supplies its own React, cards and query cache, avoiding a second runtime/cache.
export function createNewsNowWorkbench(React: typeof ReactType, api: NewsNowApi) {
  const { useState, useRef, useEffect, useLayoutEffect, useCallback } = React;
  const { Card } = api;
  const sourceIds = api.columns.hottest.sources;
  const label = (id: string) => [api.sources[id].name, api.sources[id].title].filter(Boolean).join(" · ");
  const Icon = ({ name }: { name: keyof NewsNowApi["icons"] }) => <span aria-hidden="true" className="nw-icon" dangerouslySetInnerHTML={{ __html: api.icons[name] }} />;

  return function NewsNowWorkbench() {
    const [layout, setLayout] = useState<NewsNowLayout>(() => readNewsNowLayout(null, sourceIds));
    const [layoutReady, setLayoutReady] = useState(false);
    const [state, setState] = useState<NewsNowWorkbenchState>({ total: sourceIds.length, hidden: 0, refreshing: false, completed: 0, failures: [], message: "", storageError: "" });
    const [draggedId, setDraggedId] = useState<string | null>(null);
    const grid = useRef<HTMLOListElement>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const nodes = useRef(new Map<string, HTMLLIElement>());
    const layoutRef = useRef(layout);
    const beforeRects = useRef(new Map<string, Position>());
    const entering = useRef(new Set<string>());
    const hiding = useRef(new Set<string>());
    const drag = useRef<DragSession | null>(null);
    const refreshController = useRef<AbortController | null>(null);
    const parentOrigin = useRef("");
    const reducedMotion = useRef(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const alive = useRef(true);
    layoutRef.current = layout;

    const announce = useCallback((message: string) => setState(current => ({ ...current, message })), []);
    const measure = useCallback(() => {
      const next = new Map<string, Position>();
      const container = grid.current?.getBoundingClientRect();
      if (!container) return next;
      nodes.current.forEach((node, id) => {
        const rect = node.getBoundingClientRect();
        next.set(id, { left: rect.left - container.left, top: rect.top - container.top });
      });
      return next;
    }, []);

    const changeLayout = useCallback((next: NewsNowLayout, persist = true) => {
      beforeRects.current = measure();
      layoutRef.current = next;
      setLayout(next);
      if (persist) {
        try {
          window.localStorage.setItem(NEWSNOW_LAYOUT_KEY, JSON.stringify(next));
          setState(current => ({ ...current, storageError: "" }));
        } catch {
          setState(current => ({ ...current, storageError: "浏览器未能保存卡片偏好；本次操作仍然有效，重新打开后可能恢复原布局。" }));
        }
      }
    }, [measure]);

    useLayoutEffect(() => {
      const container = grid.current?.getBoundingClientRect();
      if (!container) return;
      const frames: { node: HTMLLIElement; dx: number; dy: number; entry: boolean }[] = [];
      nodes.current.forEach((node, id) => {
        // Capture all current visual positions before cancelling in-flight transforms.
        const previous = beforeRects.current.get(id);
        node.getAnimations().forEach(animation => animation.cancel());
        const rect = node.getBoundingClientRect();
        frames.push({ node, dx: previous ? previous.left - (rect.left - container.left) : 0, dy: previous ? previous.top - (rect.top - container.top) : 0, entry: entering.current.has(id) });
      });
      for (const { node, dx, dy, entry } of frames) {
        if (entry) node.animate([{ opacity: 0, transform: "translateY(10px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: reducedMotion.current ? 0 : 280, easing: "cubic-bezier(.2,.8,.2,1)" });
        else if (dx || dy) node.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: reducedMotion.current ? 0 : 280, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
      beforeRects.current.clear();
      entering.current.clear();
    }, [layout]);

    const hide = useCallback(async (id: string) => {
      if (hiding.current.has(id) || layoutRef.current.hidden.includes(id)) return;
      hiding.current.add(id);
      const node = nodes.current.get(id);
      if (node && !reducedMotion.current) {
        const animation = node.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px) scale(.97)" }], { duration: 150, easing: "ease-in", fill: "forwards" });
        await animation.finished.catch(() => { /* Layout interruptions may cancel only this optional exit animation. */ });
      }
      hiding.current.delete(id);
      if (!alive.current) return;
      const current = layoutRef.current;
      changeLayout({ ...current, hidden: [...current.hidden, id] });
      announce(`已隐藏 ${label(id)}，可在管理卡片中恢复。`);
      requestAnimationFrame(() => {
        if (!dialog.current?.open) {
          const nextId = current.order.find(candidate => candidate !== id && !current.hidden.includes(candidate));
          nodes.current.get(nextId ?? "")?.querySelector<HTMLButtonElement>(".nw-grip")?.focus({ preventScroll: true });
        }
      });
    }, [announce, changeLayout]);

    const restore = useCallback((id?: string) => {
      const current = layoutRef.current;
      const restored = id ? [id] : current.hidden;
      restored.forEach(source => entering.current.add(source));
      changeLayout({ ...current, hidden: id ? current.hidden.filter(source => source !== id) : [] });
      announce(id ? `已恢复 ${label(id)}` : "已恢复全部卡片");
    }, [announce, changeLayout]);

    const reset = useCallback(() => {
      layoutRef.current.hidden.forEach(id => entering.current.add(id));
      changeLayout(readNewsNowLayout(null, sourceIds));
      announce("已恢复默认顺序，全部卡片已显示。");
    }, [announce, changeLayout]);

    const finishDrag = useCallback((cancel: boolean) => {
      const session = drag.current;
      if (!session) return;
      cancelAnimationFrame(session.frame);
      drag.current = null;
      session.detach();
      document.documentElement.classList.remove("nw-dragging");
      if (session.started) {
        if (cancel) changeLayout(session.before, false);
        else changeLayout(layoutRef.current);
        const target = nodes.current.get(session.id)?.getBoundingClientRect();
        const ghost = session.ghost;
        if (ghost && target && !cancel && !reducedMotion.current) {
          const rect = ghost.getBoundingClientRect();
          ghost.style.transform = `translate3d(${rect.left}px,${rect.top}px,0)`;
          ghost.animate([{ transform: ghost.style.transform, opacity: 1 }, { transform: `translate3d(${target.left}px,${target.top}px,0)`, opacity: 0 }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" }).finished.then(() => ghost.remove(), () => ghost.remove());
        } else ghost?.remove();
        setDraggedId(null);
        announce(cancel ? "已取消排序" : `已调整 ${label(session.id)} 的位置`);
      }
    }, [announce, changeLayout]);

    const beginDrag = (event: ReactType.PointerEvent<HTMLButtonElement>, id: string) => {
      if (event.button !== 0 || drag.current || hiding.current.size) return;
      const node = nodes.current.get(id);
      if (!node) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const onMove = (next: PointerEvent) => moveDrag(next);
      const onUp = () => finishDrag(false);
      const onCancel = () => finishDrag(true);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
      drag.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, ghost: null, frame: 0, started: false, before: layoutRef.current, detach: () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onCancel); window.removeEventListener("blur", onCancel); } };
    };

    const moveDrag = (event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY">) => {
      const session = drag.current;
      if (!session || session.pointerId !== event.pointerId) return;
      session.x = event.clientX; session.y = event.clientY;
      if (!session.started && Math.hypot(session.x - (nodes.current.get(session.id)!.getBoundingClientRect().left + session.offsetX), session.y - (nodes.current.get(session.id)!.getBoundingClientRect().top + session.offsetY)) < 6) return;
      if (!session.started) {
        const node = nodes.current.get(session.id)!;
        const rect = node.getBoundingClientRect();
        const ghost = node.cloneNode(true) as HTMLElement;
        ghost.className = "nw-drag-ghost";
        ghost.setAttribute("aria-hidden", "true");
        ghost.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
        Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px` });
        document.body.appendChild(ghost);
        session.ghost = ghost; session.started = true;
        setDraggedId(session.id);
        document.documentElement.classList.add("nw-dragging");
      }
      if (session.frame) return;
      const tick = () => {
        if (drag.current !== session) return;
        session.ghost!.style.transform = `translate3d(${session.x - session.offsetX}px,${session.y - session.offsetY}px,0)`;
        const edge = 56;
        const speed = session.y < edge ? -Math.ceil((edge - session.y) / 4) : session.y > innerHeight - edge ? Math.ceil((session.y - innerHeight + edge) / 4) : 0;
        const previousScroll = window.scrollY;
        if (speed) window.scrollBy(0, speed);
        const bounds = grid.current!.getBoundingClientRect();
        const x = session.x - bounds.left, y = session.y - bounds.top;
        // Hit-test layout slots rather than animated cards, so a moving neighbour cannot reverse a swap.
        const over = [...nodes.current.entries()].find(([, node]) => x >= node.offsetLeft && x <= node.offsetLeft + node.offsetWidth && y >= node.offsetTop && y <= node.offsetTop + node.offsetHeight)?.[0];
        if (over && over !== session.id) {
          const current = layoutRef.current;
          changeLayout({ ...current, order: moveNewsNowCard(current.order, session.id, over) }, false);
        }
        session.frame = window.scrollY !== previousScroll ? requestAnimationFrame(tick) : 0;
      };
      session.frame = requestAnimationFrame(tick);
    };

    const keyboardMove = (event: ReactType.KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const visible = layoutRef.current.order.filter(source => !layoutRef.current.hidden.includes(source));
      const columns = getComputedStyle(grid.current!).gridTemplateColumns.split(" ").length;
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -columns : columns;
      const index = visible.indexOf(id), nextIndex = Math.max(0, Math.min(visible.length - 1, index + direction));
      changeLayout({ ...layoutRef.current, order: moveNewsNowCard(layoutRef.current.order, id, visible[nextIndex]) });
      announce(`${label(id)} 已移动到第 ${nextIndex + 1} 位`);
    };

    const refreshAll = useCallback(async () => {
      if (refreshController.current) return;
      const controller = new AbortController();
      refreshController.current = controller;
      let completed = 0;
      const failures: NewsNowWorkbenchState["failures"] = [];
      setState(current => ({ ...current, refreshing: true, completed: 0, failures: [], message: "正在刷新全部来源…" }));
      await refreshNewsNowSources(sourceIds, async id => {
        const result = await api.request(`/s?id=${encodeURIComponent(id)}&latest`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        if (!result || result.id !== id || !Array.isArray(result.items) || !Number.isFinite(result.updatedTime)) throw new Error("来源返回格式异常，请稍后重试。");
        api.cache.set(id, result);
        api.queryClient.setQueryData(["source", id], result);
        if (result.status !== "success") throw new Error(result.fallbackReason || "来源刷新失败，保留上次成功缓存。");
      }, controller.signal, (id, error) => {
        completed++;
        if (error) failures.push({ id, label: label(id), reason: error instanceof Error && error.name !== "TimeoutError" ? error.message : "来源请求超时或连接失败，请稍后重试。" });
        setState(current => ({ ...current, completed, failures: [...failures], message: `正在刷新全部来源 ${completed}/${sourceIds.length}` }));
      });
      refreshController.current = null;
      if (!alive.current) return;
      setState(current => ({ ...current, refreshing: false, completed, failures, message: controller.signal.aborted ? `已停止刷新，完成 ${completed}/${sourceIds.length}` : failures.length ? `刷新完成：${sourceIds.length - failures.length} 个成功，${failures.length} 个失败，旧内容仍可阅读。` : `全部 ${sourceIds.length} 个来源已刷新` }));
    }, []);

    // Restore before mounting cards: loading saved preferences is not a user reorder.
    // Keep this independent of the optional referrer used by the parent bridge.
    useLayoutEffect(() => {
      try {
        const saved = readNewsNowLayout(localStorage.getItem(NEWSNOW_LAYOUT_KEY), sourceIds);
        layoutRef.current = saved;
        setLayout(saved);
      } catch (error) {
        setState(current => ({ ...current, storageError: `无法读取卡片偏好，本次暂用默认布局。${error instanceof Error ? error.message : "请检查浏览器存储权限。"}` }));
      }
      setLayoutReady(true);
    }, []);

    useEffect(() => {
      alive.current = true;
      try {
        const origin = new URL(document.referrer).origin;
        const url = new URL(origin);
        if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) parentOrigin.current = origin;
      } catch {
        // Referrer can be absent under browser privacy policies; validate the handshake below.
      }
      const listener = (event: MessageEvent) => {
        if (event.source !== window.parent || window.parent === window) return;
        const message = event.data;
        if (message?.channel !== NEWSNOW_BRIDGE_CHANNEL || message?.version !== NEWSNOW_BRIDGE_VERSION) return;
        if (!parentOrigin.current && message.type === "connect") {
          if (!URL.canParse(event.origin)) return;
          const url = new URL(event.origin);
          if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) parentOrigin.current = event.origin;
        }
        if (event.origin !== parentOrigin.current) return;
        if (message.type === "connect") {
          if (typeof message.reducedMotion === "boolean") reducedMotion.current = message.reducedMotion;
          if (message.tokens && typeof message.tokens === "object") {
            for (const [key, value] of Object.entries(message.tokens)) if (/^--[a-z-]+$/.test(key) && typeof value === "string") document.documentElement.style.setProperty(key, value);
          }
          setState(current => ({ ...current }));
        } else if (message.type === "refresh") void refreshAll();
        else if (message.type === "cancel") refreshController.current?.abort();
        else if (message.type === "manage") dialog.current?.showModal();
      };
      const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && drag.current) { event.preventDefault(); finishDrag(true); } };
      const storage = (event: StorageEvent) => {
        if (event.key !== NEWSNOW_LAYOUT_KEY) return;
        try { changeLayout(readNewsNowLayout(event.newValue, sourceIds), false); }
        catch (error) { setState(current => ({ ...current, storageError: error instanceof Error ? error.message : "卡片偏好同步失败。" })); }
      };
      window.addEventListener("message", listener);
      window.addEventListener("keydown", escape);
      window.addEventListener("storage", storage);
      return () => {
        alive.current = false;
        refreshController.current?.abort();
        const session = drag.current;
        if (session) { cancelAnimationFrame(session.frame); session.ghost?.remove(); session.detach(); }
        window.removeEventListener("message", listener);
        window.removeEventListener("keydown", escape);
        window.removeEventListener("storage", storage);
      };
    }, [changeLayout, finishDrag, refreshAll]);

    useEffect(() => {
      if (parentOrigin.current) window.parent.postMessage({ channel: NEWSNOW_BRIDGE_CHANNEL, version: NEWSNOW_BRIDGE_VERSION, type: "state", state: { ...state, hidden: layout.hidden.length } }, parentOrigin.current);
    }, [state, layout.hidden.length]);

    const visible = layoutReady ? layout.order.filter(id => !layout.hidden.includes(id)) : [];
    return <>
      <p id="nw-drag-hint" className="nw-sr-only">拖动手柄排序；也可按住 Alt 并按方向键移动卡片，Escape 取消拖动。</p>
      <p className="nw-sr-only" aria-live="polite">{state.message}</p>
      <ol ref={grid} className="grid nw-grid" aria-label="资讯来源卡片">
        {visible.map(id => <li key={id} ref={node => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); }} data-newsnow-id={id} className={draggedId === id ? "nw-card-slot nw-card-dragged" : "nw-card-slot"}>
          <Card id={id} />
          <div className="nw-card-controls">
            <button type="button" className="btn nw-control nw-grip" aria-label={`拖动排序 ${label(id)}`} aria-describedby="nw-drag-hint" title="拖动排序 · Alt + 方向键" onPointerDown={event => beginDrag(event, id)} onKeyDown={event => keyboardMove(event, id)}><Icon name="grip" /></button>
            <button type="button" className="btn nw-control nw-hide" aria-label={`隐藏 ${label(id)}`} title="隐藏卡片" onClick={() => void hide(id)}><Icon name="hide" /></button>
          </div>
          {state.failures.some(failure => failure.id === id) ? <span className="nw-card-failure" role="status" title={state.failures.find(failure => failure.id === id)?.reason}>刷新失败 · 保留旧内容</span> : null}
        </li>)}
      </ol>
      {layoutReady && !visible.length ? <div className="nw-empty"><Icon name="show" /><h2>卡片都收起来了</h2><p>随时恢复你想看的资讯来源。</p><button type="button" className="btn" onClick={() => restore()}>恢复全部卡片</button></div> : null}
      <dialog ref={dialog} className="nw-manager" aria-labelledby="nw-manager-title" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }} onClose={() => { window.parent.postMessage({ channel: NEWSNOW_BRIDGE_CHANNEL, version: NEWSNOW_BRIDGE_VERSION, type: "focus-manage" }, parentOrigin.current); }}>
        <div className="nw-manager-body">
          <header><div><h2 id="nw-manager-title">管理卡片</h2><p>拖动排序，隐藏暂时不看的来源。</p></div><button type="button" className="btn nw-control" aria-label="关闭管理卡片" onClick={() => dialog.current?.close()}><Icon name="close" /></button></header>
          <div className="nw-manager-toolbar"><span>显示 {visible.length} / {sourceIds.length}</span><button type="button" className="btn" disabled={!layout.hidden.length} onClick={() => restore()}>显示全部</button><button type="button" className="btn" onClick={reset}><Icon name="reset" />重置布局</button></div>
          {state.storageError ? <p className="nw-storage-error" role="alert">{state.storageError}</p> : null}
          <ul>{layout.order.map(id => <li key={id}><span><strong>{api.sources[id].name}</strong><small>{api.sources[id].title}</small></span><button type="button" className="btn nw-visibility" aria-label={`${layout.hidden.includes(id) ? "显示" : "隐藏"} ${label(id)}`} aria-pressed={!layout.hidden.includes(id)} onClick={() => layout.hidden.includes(id) ? restore(id) : void hide(id)}><Icon name={layout.hidden.includes(id) ? "show" : "check"} />{layout.hidden.includes(id) ? "显示" : "已显示"}</button></li>)}</ul>
        </div>
      </dialog>
    </>;
  };
}
