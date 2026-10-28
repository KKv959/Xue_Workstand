"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ExternalLink, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { WorkbenchSelect } from "@/components/WorkbenchSelect";
import { AI_EFFORTS, AI_GROUPS, AI_POLICIES, type AiEffort, type AiPolicyValue } from "@/lib/ai-policy-catalog";
import { useAiSettings } from "./useAiSettings";
import "./settings.css";

type Settings = {
  provider: string;
  model: string;
  thinking: string;
  subscriptions: { provider: string; connected: boolean; models: { id: string; name: string }[] }[];
};

const effortLabels = { low: "轻量", medium: "均衡", high: "深入", xhigh: "最高" };
const relayModels = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"];

function PolicySettings() {
  const w = useAiSettings();
  return <details className="ai-settings-section ai-settings-advanced" data-unsaved-changes={w.dirty ? "true" : undefined}>
    <summary className="ai-settings-advanced-summary"><SlidersHorizontal size={18} aria-hidden="true" /><span><strong>高级设置</strong><span>各环节的调用来源与中转配置</span></span><span role="status" className="ai-save-state">{w.loading ? "读取中…" : w.error ? "配置异常，展开查看" : w.dirty ? `${w.dirtyIds.length} 项待保存` : ""}</span><ChevronDown className="ai-settings-chevron" size={18} aria-hidden="true" /></summary>
    <div className="ai-settings-advanced-body">
    <p className="ai-settings-footnote">订阅沿用上方默认模型；「订阅优先」在不可用时使用中转。</p>
    {w.error && <p role="alert" className="ai-settings-notice error">{w.error} <button className="btn compact" type="button" disabled={w.loading || w.saving} onClick={() => void w.load()}>重试</button></p>}
    {w.message && <p role="status" className="ai-settings-notice">{w.message}</p>}
    {w.saved && <div className="ai-policy-list" aria-busy={w.saving}>
      {AI_GROUPS.slice(1).map(group => <div key={group} className="ai-policy-group"><h3>{group}</h3>
        {AI_POLICIES.filter(p => p.group === group && !("retired" in p && p.retired)).map(policy => {
          const fixed = policy.id === "web_research";
          const value = w.overrides[policy.id] || w.saved!.defaults[policy.id];
          const source = fixed ? "relay" : value.source || (policy.id === "image_generate" ? "relay" : "auto");
          const isImage = "kind" in policy;
          const models = isImage ? w.saved!.models.filter(model => model.startsWith("gpt-image")) : [...new Set([value.model, w.saved!.inheritedModels[policy.id], ...relayModels].filter(Boolean))];
          const model = value.model || w.saved!.inheritedModels[policy.id];
          const effort = value.effort === "default" ? w.saved!.inheritedEfforts[policy.id] : value.effort;
          return <div className="ai-policy-row" key={policy.id}>
            <div className="ai-policy-name"><strong>{policy.title}{w.dirtyIds.includes(policy.id) && <small> 待保存</small>}</strong></div>
            <label><span>调用来源</span><WorkbenchSelect aria-label={`${policy.title}调用来源`} disabled={fixed || w.saving} value={source} onValueChange={next => w.change([policy.id], { source: next as AiPolicyValue["source"] })}>
              {policy.id !== "image_generate" && <option value="auto">订阅优先</option>}<option value="subscription">仅订阅</option><option value="relay">仅中转</option>
            </WorkbenchSelect></label>
            {source !== "subscription" ? <><label><span>中转模型</span><WorkbenchSelect aria-label={`${policy.title}中转模型`} disabled={w.saving} value={model} onValueChange={next => w.change([policy.id], { model: next })}>
              {models.map(item => <option key={item} value={item}>{item}</option>)}
            </WorkbenchSelect></label>
            <label><span>中转推理</span><WorkbenchSelect aria-label={`${policy.title}中转推理强度`} disabled={isImage || w.saving} value={isImage ? "none" : effort} onValueChange={next => w.change([policy.id], { effort: next as AiEffort })}>
              {isImage ? <option value="none">不适用</option> : AI_EFFORTS.filter(item => item !== "none").map(item => <option key={item} value={item}>{effortLabels[item]}</option>)}
            </WorkbenchSelect></label>
            </> : <span className="ai-policy-subscription">{isImage ? "ChatGPT 订阅生图" : "使用默认模型"}</span>}
            <button className="btn compact" type="button" disabled={!w.overrides[policy.id] || w.saving} onClick={() => w.change([policy.id], null)}>重置</button>
          </div>;
        })}</div>)}
      <p className="ai-settings-footnote">联网检索仅支持中转。生图设置保存后需重新打开生图页；订阅生图仅本机可用，失败不转中转。语音转写： {w.saved.services.asr}。</p>
    </div>}
    <div className="ai-settings-actions"><button className="btn" type="button" disabled={!w.dirty || w.saving} onClick={w.discard}>撤销修改</button><button className="btn primary" type="button" disabled={!w.dirty || w.saving || w.loading} aria-busy={w.saving} onClick={() => void w.save()}><Save size={16} aria-hidden="true" />保存高级设置</button></div>
    </div>
  </details>;
}

async function readResponse<T>(response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(typeof data === "object" && data !== null && "error" in data ? String(data.error) : "请求失败");
  return data as T;
}

export default function AiSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const provider = "openai-codex";
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("medium");
  const [verifyUrl, setVerifyUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const loginController = useRef<AbortController | null>(null);

  async function load(preferredProvider?: string) {
    try {
      const data = await readResponse<Settings>(await fetch("/api/pi-settings", { cache: "no-store" }));
      setSettings(data);
      const models = data.subscriptions.find(item => item.provider === "openai-codex")?.models || [];
      setModel(!preferredProvider && data.provider === "openai-codex" ? data.model || models[0]?.id || "" : models[0]?.id || "");
      setThinking(data.thinking);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取模型配置失败"); }
  }

  useEffect(() => { void load(); return () => loginController.current?.abort(); }, []);

  async function login(loginProvider: "openai-codex") {
    const controller = new AbortController();
    loginController.current = controller;
    setBusy(true);
    setVerifyUrl("");
    setError("");
    setMessage("正在准备浏览器授权…");
    try {
      const response = await fetch("/api/pi-settings/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: loginProvider }), signal: controller.signal });
      if (!response.ok) await readResponse(response);
      if (!response.body) throw new Error("登录响应不可用");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let connected = false;
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "stage") setMessage(event.message || "正在确认订阅凭证…");
          if (event.type === "result" && event.data?.verificationUri) {
            setVerifyUrl(event.data.verificationUri);
            setMessage("请打开授权页面并完成 ChatGPT 登录");
          }
          if (event.type === "result" && event.data?.connected) connected = true;
        }
        if (done) break;
      }
      if (!connected) throw new Error("登录连接已中断，请重新发起订阅登录");
      setMessage("订阅已连接，请选择模型并保存");
      setVerifyUrl("");
      await load(loginProvider);
    } catch (cause) {
      if (!controller.signal.aborted) {
        await load();
        setMessage("");
        setVerifyUrl("");
        setError(cause instanceof Error ? cause.message : "订阅登录失败");
      }
    }
    finally { loginController.current = null; setBusy(false); }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await readResponse<{ saved: boolean; verified: boolean; warning?: string }>(await fetch("/api/pi-settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, thinking })
      }));
      setMessage(result.warning ? `默认模型已保存，但连通性验证遇到临时问题：${result.warning}；新请求仍会使用该模型。` : "默认模型已保存，新请求立即生效");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存模型配置失败"); }
    finally { setBusy(false); }
  }

  const selected = settings?.subscriptions.find(item => item.provider === provider);
  const connected = selected?.connected;
  const dirty = Boolean(settings && (settings.provider !== provider || settings.model !== model || settings.thinking !== thinking));
  return <div className="page ai-settings-page">
    <header className="page-header"><div><h1>AI 模型配置</h1><p>管理订阅与默认模型</p></div></header>
    {error && <p role="alert" className="ai-settings-notice error">{error}</p>}
    {message && <p role="status" className="ai-settings-notice">{message}</p>}
    <section className="panel ai-settings-section ai-settings-subscription" aria-labelledby="subscription-heading" aria-busy={busy} data-unsaved-changes={dirty ? "true" : undefined}>
      <div className="ai-settings-section-head">
        <div><h2 id="subscription-heading">ChatGPT 订阅</h2><p>连接账号，使用订阅模型完成创作。</p></div>
        <span className={`status-pill ${connected ? "done" : "pending"}`}>{!settings ? "未读取" : connected ? "已连接" : "未连接"}</span>
      </div>
      <div className="ai-settings-connection">
        <button className={`btn ${connected ? "" : "primary"}`} type="button" disabled={busy || !settings} onClick={() => void login("openai-codex")}>{busy && loginController.current ? "等待授权…" : connected ? "重新连接" : "连接账号"}</button>
        <button className="btn icon-only" type="button" aria-label="刷新模型状态" disabled={busy} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" /></button>
        {busy && loginController.current && <button className="btn" type="button" onClick={() => { loginController.current?.abort(); setVerifyUrl(""); setMessage("已取消订阅登录"); }}>取消登录</button>}
        {verifyUrl && <a className="ai-settings-auth-link" href={verifyUrl} target="_blank" rel="noopener noreferrer">打开授权页面 <ExternalLink size={15} aria-hidden="true" /></a>}
      </div>
      <div className="ai-settings-model-area">
        <div className="ai-settings-fields">
          <label><span>默认模型</span>{connected ? <WorkbenchSelect aria-label="默认模型" disabled={busy} value={model} onValueChange={setModel}>
            {selected.models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </WorkbenchSelect> : <span className="ai-settings-placeholder">连接账号后可选择</span>}</label>
          <label><span>推理强度</span><WorkbenchSelect aria-label="推理强度" disabled={busy || !connected} value={thinking} onValueChange={setThinking}>
            {Object.entries({ off: "关闭", minimal: "最低", ...effortLabels }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </WorkbenchSelect></label>
        </div>
        <div className="ai-settings-footer">
          <span className="ai-save-state" role="status">{!settings ? "等待读取配置" : dirty ? "有未保存的修改" : settings.model ? "已保存" : "尚未配置模型"}</span>
          <button className="btn primary" type="button" disabled={busy || !dirty || !model || !connected} onClick={() => void save()}><Save size={16} aria-hidden="true" />{busy && !loginController.current ? "保存中…" : "保存设置"}</button>
        </div>
        {settings && settings.provider !== provider && settings.model && <p className="ai-settings-footnote">当前仍使用旧来源，请连接订阅并保存以切换。</p>}
      </div>
    </section>
    <PolicySettings />
  </div>;
}
