"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Calculator,
  CheckCircle2,
  Gauge,
  MessageSquarePlus,
  Radar,
  RefreshCw,
  Settings2,
  Server,
  Wrench
} from "lucide-react";
import { useRemoteStatus } from "@/components/RemoteStatusProvider";
import type { RemoteStatusResponse } from "@/lib/types";

const featureItems = [
  { href: "/hotspots", label: "热点雷达", detail: "查看热点发现和内容机会", icon: Radar, mobileReady: false },
  { href: "/assets", label: "评论生成", detail: "生成评论、弹幕和封面素材", icon: MessageSquarePlus, mobileReady: false },
  { href: "/tools", label: "工具台", detail: "单条视频转写、下载和发布", icon: Wrench, mobileReady: false },
  { href: "/ai-settings", label: "AI 模型配置", detail: "连接订阅并选择默认模型", icon: Settings2, mobileReady: false },
  { href: "/gross-margin", label: "数据维护", detail: "维护账号报价和毛利数据", icon: Calculator, mobileReady: false },
  { href: "/gross-margin/monitor", label: "数据监控", detail: "跟踪发布后的执行数据", icon: Activity, mobileReady: false },
];

const serviceLabels: Record<keyof RemoteStatusResponse["services"], string> = {
  storage: "素材库",
  opencli: "OpenCLI",
  browserBridge: "浏览器桥接",
  ffmpeg: "ffmpeg",
  chat: "对话模型",
  image: "图片模型"
};

export default function MobileMorePage() {
  const remote = useRemoteStatus();

  return (
    <div className="mobile-more page">
      <header className="mobile-page-header">
        <span className="mobile-eyebrow">更多功能</span>
        <h1>工作台与服务</h1>
        <p>核心功能已针对手机优化，其余页面可以打开，但复杂操作更适合电脑端。</p>
      </header>

      <section className="mobile-section">
        <div className="mobile-section-heading">
          <div>
            <span className="mobile-eyebrow">功能入口</span>
            <h2>完整工作台</h2>
          </div>
        </div>
        <div className="mobile-list">
          {featureItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link className="mobile-list-row" href={item.href} key={item.href}>
                <span className="mobile-list-icon"><Icon aria-hidden="true" size={18} /></span>
                <span className="mobile-list-copy">
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                {!item.mobileReady ? <span className="mobile-desktop-hint">桌面更佳</span> : null}
                <ArrowRight aria-hidden="true" size={17} />
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mobile-section" id="service-status">
        <div className="mobile-section-heading">
          <div>
            <span className="mobile-eyebrow">远程环境</span>
            <h2>服务状态</h2>
          </div>
          <button
            aria-label="重新检查全部服务"
            className="btn icon-only"
            onClick={() => void remote.refresh({ fresh: true })}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={17} />
          </button>
        </div>
        <div className="mobile-service-summary">
          <Server aria-hidden="true" size={20} />
          <div>
            <strong>{remote.status ? `版本 ${remote.status.app.version}` : "正在读取版本"}</strong>
            <small>{remote.status?.app.buildId || remote.error || "等待后台响应"}</small>
          </div>
          <span className={`status-pill ${remote.connection === "online" ? "completed" : remote.connection === "degraded" ? "pending" : "failed"}`}>
            {remote.connection === "online" ? "在线" : remote.connection === "degraded" ? "部分可用" : remote.connection === "checking" ? "检查中" : "离线"}
          </span>
        </div>
        {remote.status ? (
          <div className="mobile-service-grid">
            {Object.entries(remote.status.services).map(([key, value]) => (
              <div className={`mobile-service-row ${value.status}`} key={key}>
                {value.status === "ok" ? (
                  <CheckCircle2 aria-hidden="true" size={18} />
                ) : value.status === "unavailable" ? (
                  <AlertTriangle aria-hidden="true" size={18} />
                ) : (
                  <Gauge aria-hidden="true" size={18} />
                )}
                <div>
                  <strong>{serviceLabels[key as keyof RemoteStatusResponse["services"]]}</strong>
                  <small>{value.message || formatServiceState(value.status)}</small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mobile-alert-card">
            <AlertTriangle aria-hidden="true" size={20} />
            <span>{remote.error || "正在检查服务…"}</span>
          </div>
        )}
      </section>

      <section className="mobile-section">
        <div className="mobile-note-card">
          <strong>远程使用提醒</strong>
          <p>MacBook 需要插电、开盖并联网。合盖睡眠或关机后，手机将无法连接后台。</p>
        </div>
      </section>
    </div>
  );
}

function formatServiceState(status: RemoteStatusResponse["services"]["storage"]["status"]) {
  if (status === "ok") return "可用";
  if (status === "unconfigured") return "未配置";
  return "不可用";
}
