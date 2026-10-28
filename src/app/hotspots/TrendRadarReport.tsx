"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCw } from "lucide-react";
import { WorkbenchSelect } from "@/components/WorkbenchSelect";
import { useScopedTasks } from "@/components/TaskProvider";
import { getTrendRadarNativeStatus } from "@/lib/client";
import { trendRadarSettingsSchema, type TrendRadarSettings, type TrendRadarNativeStatus } from "@/lib/trendradar-native-types";
import "./trendradar-report.css";
import { integrateReport } from "./report-embed";

export default function TrendRadarReport() {
  const tasks = useScopedTasks({ href: "/hotspots", kinds: ["hotspot-refresh"] });
  const [state, setState] = useState<TrendRadarNativeStatus | null>(null);
  const [settings, setSettings] = useState<TrendRadarSettings>(() => trendRadarSettingsSchema.parse({}));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [revision, setRevision] = useState(0);
  const restored = useRef(false);
  const [readingView, setReadingView] = useState<"analysis" | "sources">("analysis");
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const body = frameRef.current?.contentDocument?.body;
    if (body) body.dataset.readingView = readingView;
  }, [readingView]);
  const reportCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => reportCleanup.current?.(), []);
  const active = tasks.activeJobs[0];
  const job = active || tasks.recentJobs[0];
  const jobKey = job ? `${job.id}:${job.status}:${job.dataRevision || 0}` : "";
  useEffect(() => {
    const controller = new AbortController();
    getTrendRadarNativeStatus(controller.signal).then(value => {
      setState(value); setError("");
      if (!restored.current) { setSettings(value.defaults); restored.current = true; }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取报告失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [jobKey, revision]);
  async function generate() {
    setStarting(true); setError("");
    try {
      const parsed = trendRadarSettingsSchema.safeParse(settings);
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      await tasks.startTask({ kind: "hotspot-refresh", title: "生成 TrendRadar 报告", href: "/hotspots?view=topics", input: { native: parsed.data } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "启动报告任务失败"); }
    finally { setStarting(false); }
  }
  const report = state?.report;
  const failedJob = !active && job && ["failed", "interrupted", "cancelled"].includes(job.status) ? job : undefined;
  return <section className="trendradar-report" aria-busy={loading || starting || Boolean(active)}>
    <header className="trendradar-report-heading"><h1>热点分析</h1><div className="trendradar-report-actions">
      <button className="btn compact" onClick={() => setRevision(value => value + 1)} aria-label="重新读取已保存报告"><RefreshCw size={16} />读取报告</button>
      <button className="btn primary" disabled={loading || starting || Boolean(active)} onClick={() => void generate()}>{starting ? "正在启动…" : "生成报告"}</button>
      </div>
    </header>
    <details className="trendradar-generation" open={!loading && !report ? true : undefined}>
    <summary>采集设置<span>{settings.mode === "daily" ? "全天汇总" : settings.mode === "current" ? "当前榜单" : "增量更新"} · {settings.filter === "ai" ? "AI 兴趣筛选" : "关键词筛选"}</span></summary>
    <div className="trendradar-generation-body">
    <div className="trendradar-report-settings">
      <label className="field">报告范围<WorkbenchSelect aria-label="报告范围" value={settings.mode} onValueChange={value => setSettings({ ...settings, mode: value as TrendRadarSettings["mode"] })}>
        <option value="daily">全天汇总</option><option value="current">当前榜单</option><option value="incremental">增量更新</option>
      </WorkbenchSelect></label>
      <label className="field">筛选方式<WorkbenchSelect aria-label="筛选方式" value={settings.filter} onValueChange={value => setSettings({ ...settings, filter: value as TrendRadarSettings["filter"] })}>
        <option value="ai">AI 兴趣筛选</option><option value="keyword">已配置关键词</option>
      </WorkbenchSelect></label>
    </div>
    {settings.filter === "ai" ? <label className="field trendradar-report-interests">关注方向<textarea rows={3} maxLength={2000} value={settings.interests} onChange={event => setSettings({ ...settings, interests: event.target.value })} /></label> : <p className="subtle">使用 TrendRadar 已配置的关键词分组，筛选后生成 AI 分析报告。</p>}
    </div></details>
    {error ? <p role="alert" className="error">{error}</p> : null}
    {failedJob ? <div role="status">
      <p className="error">{failedJob.error || failedJob.message}。{report ? "已保存的报告仍可阅读。" : loading ? "正在检查已保存报告。" : "本次未生成报告。"}</p>
      {failedJob.status === "failed" && /Pi|模型|中转|额度|限流/.test(failedJob.error || failedJob.message || "") ? <Link className="btn compact" href="/ai-settings">检查 AI 模型配置</Link> : null}
    </div> : null}
    {report ? <>
      <div className="trendradar-reading-toolbar">
      <nav className="radar-content-tabs" aria-label="报告内容">
        <button aria-pressed={readingView === "analysis"} onClick={() => setReadingView("analysis")}>分析报告</button>
        <button aria-pressed={readingView === "sources"} onClick={() => setReadingView("sources")}>资讯来源</button>
      </nav>
      <details className="trendradar-report-details"><summary>报告详情</summary>
        <p>{new Date(report.generatedAt).toLocaleString("zh-CN")} · 分析 {report.counts.analyzed} 条资讯</p>
        {report.fallback ? <p>本轮使用备用模型：{report.fallbackReason}</p> : null}
        <a className="btn compact" href="/api/hotspots/native/html" target="_blank" rel="noreferrer">独立打开报告<ExternalLink size={14} /></a>
      </details>
      </div>
      {report.warnings.map((warning, index) => <p className="error" key={index}>{warning}</p>)}
      <div className="trendradar-native-viewport"><iframe ref={frameRef} key={report.generatedAt} className="newsnow-frame" onLoad={event => {
        reportCleanup.current?.();
        try {
          reportCleanup.current = integrateReport(event.currentTarget);
          event.currentTarget.contentDocument!.body.dataset.readingView = readingView;
        }
        catch (reason) { setError(reason instanceof Error ? reason.message : "报告样式加载失败，请重新读取报告"); }
      }} src={`/api/hotspots/native/html?v=${encodeURIComponent(report.generatedAt)}`} title="TrendRadar 热点分析报告" sandbox="allow-scripts allow-same-origin allow-popups allow-downloads" /></div>
    </> : active || starting ? null : <p role="status">{loading ? "正在读取报告…" : "选择报告范围和关注方向，生成第一份 TrendRadar 报告。"}</p>}
  </section>;
}
