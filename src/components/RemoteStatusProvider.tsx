"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { getRemoteStatus } from "@/lib/client";
import type { RemoteStatusResponse } from "@/lib/types";
import { confirmDiscardUnsavedChanges } from "./UnsavedChangesGuard";

type RemoteConnectionState = "checking" | "online" | "degraded" | "offline";

type RemoteStatusContextValue = {
  status: RemoteStatusResponse | null;
  connection: RemoteConnectionState;
  error: string;
  buildMismatch: boolean;
  refresh: (options?: { fresh?: boolean }) => Promise<void>;
  reloadForUpdate: () => void;
};

const RemoteStatusContext = createContext<RemoteStatusContextValue | null>(null);
const STATUS_REFRESH_INTERVAL_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;

export function RemoteStatusProvider({
  children,
  currentBuildId
}: {
  children: React.ReactNode;
  currentBuildId: string;
}) {
  const [status, setStatus] = useState<RemoteStatusResponse | null>(null);
  const [connection, setConnection] = useState<RemoteConnectionState>("checking");
  const [error, setError] = useState("");
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async (options: { fresh?: boolean } = {}) => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    const run = getRemoteStatus({ fresh: options.fresh, signal: controller.signal })
      .then((next) => {
        setStatus(next);
        setConnection(next.app.status === "degraded" ? "degraded" : "online");
        setError("");
      })
      .catch((cause) => {
        setConnection("offline");
        setError(describeConnectionError(cause));
      })
      .finally(() => {
        window.clearTimeout(timer);
        refreshPromiseRef.current = null;
      });
    refreshPromiseRef.current = run;
    return run;
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, STATUS_REFRESH_INTERVAL_MS);
    // 网络恢复时才强制体检；切回窗口只读服务端 60 秒缓存，避免每次聚焦都启动 opencli / ffmpeg 检查。
    const onAvailable = () => void refresh({ fresh: true });
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("online", onAvailable);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", onAvailable);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const buildMismatch = Boolean(
    status &&
    currentBuildId &&
    status.app.buildId !== currentBuildId &&
    !currentBuildId.startsWith("dev-")
  );

  const reloadForUpdate = useCallback(() => {
    const confirmed = confirmDiscardUnsavedChanges("当前页面有未保存内容。刷新会丢失这些修改，仍要更新吗？");
    if (!confirmed) return;
    window.location.reload();
  }, []);

  const value = useMemo(() => ({
    status,
    connection,
    error,
    buildMismatch,
    refresh,
    reloadForUpdate
  }), [buildMismatch, connection, error, refresh, reloadForUpdate, status]);

  return (
    <RemoteStatusContext.Provider value={value}>
      {buildMismatch ? (
        <div className="remote-update-banner" role="status">
          <RefreshCw aria-hidden="true" size={16} />
          <span>后台已更新，新版本可以使用。</span>
          <button className="btn compact primary" onClick={reloadForUpdate} type="button">
            刷新更新
          </button>
        </div>
      ) : null}
      {connection === "offline" ? (
        <div className="remote-offline-banner" role="alert">
          <WifiOff aria-hidden="true" size={16} />
          <span>{error}</span>
          <button className="btn compact" onClick={() => void refresh({ fresh: true })} type="button">
            重试
          </button>
        </div>
      ) : null}
      {children}
    </RemoteStatusContext.Provider>
  );
}

export function useRemoteStatus() {
  const context = useContext(RemoteStatusContext);
  if (!context) throw new Error("useRemoteStatus must be used inside RemoteStatusProvider");
  return context;
}

function describeConnectionError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "后台连接超时。请确认 MacBook 正在开机且没有休眠。";
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "iPhone 当前没有网络连接。";
  }
  const message = error instanceof Error ? error.message : "";
  if (/Failed to fetch|无法连接|NetworkError|Load failed/i.test(message)) {
    return "无法连接后台。请确认 MacBook 正在开机且没有休眠。";
  }
  return message || "后台暂时不可用，请稍后重试。";
}
