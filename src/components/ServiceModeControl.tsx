"use client";

import { useEffect, useRef, useState } from "react";
import { Server } from "lucide-react";
import { ModalBackdrop } from "./ModalBackdrop";
import { confirmDiscardUnsavedChanges } from "./UnsavedChangesGuard";
import { getServiceMode, switchServiceMode } from "@/lib/client";
import type { ServiceMode, ServiceModeStatus } from "@/lib/types";

export function ServiceModeControl() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ServiceModeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const focus = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function show() {
    setOpen(true);
    setMessage("");
    try { setStatus(await getServiceMode()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "读取服务模式失败。"); }
  }

  async function change(mode: ServiceMode) {
    if (!confirmDiscardUnsavedChanges("切换服务后需要刷新页面。请先保存未保存内容，仍要切换吗？")) return;
    setBusy(true);
    setMessage("正在切换，服务会短暂断开…");
    const abort = new AbortController();
    controller.current = abort;
    let lastError = "";
    try {
      await switchServiceMode(mode);
      const deadline = Date.now() + 45_000;
      while (!abort.signal.aborted && Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        let next: ServiceModeStatus;
        try {
          next = await getServiceMode(AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]));
        } catch (error) {
          lastError = error instanceof Error ? error.message : "无法连接后台";
          // 服务重启期间连接失败是预期状态；超时后明确显示最后一次错误。
          continue;
        }
        if (!next.switching && next.error) throw new Error(next.error);
        setStatus(next);
        if (next.mode === mode && !next.switching) {
          setMessage("切换完成，刷新页面即可使用。");
          return;
        }
      }
      if (!abort.signal.aborted) throw new Error(`切换未在 45 秒内完成，请检查服务日志。${lastError}`);
    } catch (error) {
      if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "切换服务失败。");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }

  return <>
    <button className="btn ghost nav-link sidebar-settings" style={{ width: "100%", justifyContent: "flex-start" }} type="button" onClick={() => void show()} aria-haspopup="dialog">
      <Server size={18} strokeWidth={1.75} aria-hidden="true" /><span>服务模式</span>
    </button>
    {open ? <ModalBackdrop className="modal-panel confirm-panel" aria-labelledby="service-mode-title" initialFocusRef={focus} disabled={busy} onClose={() => setOpen(false)}>
      <div className="confirm-dialog-body">
        <Server aria-hidden="true" size={20} />
        <div>
          <h2 id="service-mode-title">服务模式</h2>
          <div className="confirm-dialog-content">
            <p>当前：{status ? status.mode === "development" ? "开发服务 · 修改代码自动更新" : "正式服务 · 上次发布的版本" : "正在读取…"}</p>
            <p>切换会短暂重启，有运行或排队任务时会阻止切换。正式服务使用上次发布的版本，不会自动发布当前代码。</p>
            {status && !status.available ? <p role="status">{status.reason}</p> : null}
            <p role="status" aria-live="polite">{message || status?.error}</p>
          </div>
        </div>
      </div>
      <div className="confirm-dialog-actions" aria-busy={busy}>
        <button className="btn" disabled={busy || !status?.available || status.mode === "development" || status.switching} onClick={() => void change("development")} type="button">切到开发服务</button>
        <button className="btn" disabled={busy || !status?.available || status.mode === "production" || status.switching} onClick={() => void change("production")} type="button">切到正式服务</button>
        <button className="btn" ref={focus} disabled={busy} onClick={() => {
          if (confirmDiscardUnsavedChanges("刷新会丢失未保存内容，仍要刷新吗？")) window.location.reload();
        }} type="button">刷新页面</button>
      </div>
    </ModalBackdrop> : null}
  </>;
}
