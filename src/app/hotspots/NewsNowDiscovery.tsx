"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, ExternalLink, PanelsTopLeft, RefreshCw, Square } from "lucide-react";
import { getNewsNowStatus } from "@/lib/client";
import { NEWSNOW_BRIDGE_CHANNEL, NEWSNOW_BRIDGE_VERSION, NEWSNOW_ORIGIN, NEWSNOW_URL, type NewsNowStatus, type NewsNowWorkbenchCommand, type NewsNowWorkbenchState } from "@/lib/newsnow";
import { isNewsNowWorkbenchMessage } from "@/lib/newsnow-workbench-state";

const themeTokens = ["--bg", "--panel", "--panel-soft", "--text", "--text-strong", "--muted", "--line", "--line-strong", "--accent", "--accent-tint", "--rose", "--overlay", "--glass-popover", "--glass-blur", "--shadow-float", "--control-radius", "--radius-lg", "--motion-base", "--motion-slow"];

export function NewsNowDiscovery({ navigation }: { navigation: ReactNode }) {
  const [status, setStatus] = useState<NewsNowStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [workbench, setWorkbench] = useState<NewsNowWorkbenchState | null>(null);
  const [bridgeError, setBridgeError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const manage = useRef<HTMLButtonElement>(null);
  const command = useCallback((type: NewsNowWorkbenchCommand["type"]) => {
    const message: NewsNowWorkbenchCommand = { channel: NEWSNOW_BRIDGE_CHANNEL, version: NEWSNOW_BRIDGE_VERSION, type };
    if (type === "connect") {
      const style = getComputedStyle(document.documentElement);
      message.tokens = Object.fromEntries(themeTokens.map(token => [token, style.getPropertyValue(token).trim()]));
      message.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    frame.current?.contentWindow?.postMessage(message, NEWSNOW_ORIGIN);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (!["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) || window.location.protocol !== "http:") {
      setStatus({ available: false, message: "资讯发现目前仅支持本机访问，请在运行工作台的 Mac 上打开 http://127.0.0.1:3000/hotspots。" });
      return () => controller.abort();
    }
    async function check() {
      try {
        const result = await getNewsNowStatus(controller.signal);
        if (!controller.signal.aborted) setStatus(result);
      } catch (error) {
        if (!controller.signal.aborted) setStatus({ available: false, message: error instanceof Error ? error.message : "检查 NewsNow 连接失败，请重试。" });
      }
    }
    void check();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void check(); }, 30000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [attempt]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== NEWSNOW_ORIGIN) return;
      if (isNewsNowWorkbenchMessage(event.data)) { setWorkbench(event.data.state); setBridgeError(""); }
      else if (event.data?.channel === NEWSNOW_BRIDGE_CHANNEL && event.data?.version === NEWSNOW_BRIDGE_VERSION && event.data?.type === "focus-manage") manage.current?.focus();
    };
    window.addEventListener("message", listener);
    const themeObserver = new MutationObserver(() => command("connect"));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motionChanged = () => command("connect");
    media.addEventListener("change", motionChanged);
    return () => { window.removeEventListener("message", listener); themeObserver.disconnect(); media.removeEventListener("change", motionChanged); };
  }, [command]);

  useEffect(() => {
    if (!status?.available || loaded) return;
    const timer = window.setTimeout(() => setSlow(true), 15000);
    return () => window.clearTimeout(timer);
  }, [status?.available, loaded, attempt]);

  useEffect(() => {
    if (!loaded || workbench) return;
    command("connect");
    const timer = window.setTimeout(() => setBridgeError("资讯交互层未连接，请重新连接；若仍未恢复，请运行 NewsNow 交互安装脚本。"), 10000);
    return () => window.clearTimeout(timer);
  }, [loaded, workbench, command]);

  function reconnect() {
    setStatus(null); setLoaded(false); setSlow(false); setWorkbench(null); setBridgeError(""); setAttempt(value => value + 1);
  }

  return <section className="newsnow-discovery" aria-label="NewsNow 资讯浏览">
    <div className="newsnow-toolbar">{navigation}<div className="newsnow-actions">
      {workbench?.refreshing ? <span className="newsnow-refresh-status" role="status" aria-live="polite">{workbench.completed}/{workbench.total}</span> : null}
      <button ref={manage} className="btn compact newsnow-manage" disabled={!workbench} onClick={() => command("manage")} title="管理卡片，可恢复隐藏来源"><PanelsTopLeft size={14} /><span>管理卡片</span>{workbench?.hidden ? <small>{workbench.hidden}</small> : null}</button>
      <button className="btn compact icon-btn" disabled={!workbench && !bridgeError && status?.available} aria-label={workbench?.refreshing ? "停止刷新全部来源" : workbench ? "刷新全部来源" : "重新连接资讯"} title={workbench?.refreshing ? "停止刷新" : workbench ? `刷新全部 ${workbench.total} 个来源（含隐藏卡片）` : "重新连接"} aria-busy={workbench?.refreshing} onClick={() => workbench ? command(workbench.refreshing ? "cancel" : "refresh") : reconnect()}>{workbench?.refreshing ? <Square size={13} /> : <RefreshCw size={14} />}</button>
      <a className="btn compact icon-btn" aria-label="独立打开资讯" title="独立打开" href={NEWSNOW_URL} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
      {workbench && !workbench.refreshing && workbench.failures.length ? <details className="newsnow-failures">
        <summary className="btn compact icon-btn" aria-label={`${workbench.failures.length} 个来源刷新失败，查看详情`} title="查看刷新失败的来源"><CircleAlert size={14} /><small aria-hidden="true">{workbench.failures.length}</small></summary>
        <div className="newsnow-failure-panel"><strong>{workbench.failures.length} 个来源刷新失败</strong><ul>{workbench.failures.map(failure => <li key={failure.id}><b>{failure.label}</b>：{failure.reason}</li>)}</ul></div>
      </details> : null}
    </div></div>
    {bridgeError ? <div className="newsnow-feedback" role="alert">{bridgeError}<button className="btn compact" onClick={reconnect}>重新连接</button></div> : null}
    {workbench?.storageError ? <p className="newsnow-feedback" role="alert">{workbench.storageError}</p> : null}
    {status?.available ? <>
      {slow ? <p className="subtle" role="status">内嵌页面加载较慢。若内容空白，请尝试重新连接或独立打开。</p> : null}
      <div className="newsnow-viewport">
        <iframe ref={frame} key={attempt} className="newsnow-frame" src={NEWSNOW_URL} title="NewsNow 实时资讯" onLoad={() => { setLoaded(true); setSlow(false); command("connect"); }} onError={() => setStatus({ available: false, message: "NewsNow 页面加载失败，请重新连接或独立打开。" })} />
      </div>
    </> : <div className="newsnow-placeholder" aria-busy={!status}>
      <h2>{status ? "暂时无法打开资讯发现" : "正在打开资讯发现"}</h2>
      <p role={status ? "alert" : "status"}>{status?.message || "正在检查本机 NewsNow 服务…"}</p>
      {status ? <p className="subtle">已有 AI 选题仍可在上方页签查看。</p> : null}
    </div>}
  </section>;
}
