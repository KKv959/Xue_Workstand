"use client";

import { Check, Clapperboard, Image, MessageSquare, Newspaper, PenLine, RotateCcw, SlidersHorizontal } from "lucide-react";
import { WorkbenchSelect } from "@/components/WorkbenchSelect";
import { AI_EFFORTS, AI_POLICIES, type AiEffort } from "@/lib/ai-policy-catalog";
import { useAiSettings } from "./useAiSettings";
import "./settings.css";

const effortLabels = { low: "轻量", medium: "均衡", high: "深入", xhigh: "最高" };
const modelLabels: Record<string, string> = {
  "gpt-6-astra": "6-Astra",
  "gpt-6.1-sol": "6.1-Sol",
  "gpt-6-sol": "6-Sol",
  "gpt-5.6-sol": "5.6-Sol"
};
const groups = [
  { name: "热点分析", icon: Newspaper, description: "发现值得关注的内容" },
  { name: "风格学习", icon: Clapperboard, description: "学习账号的表达方式" },
  { name: "对话写作", icon: PenLine, description: "从创作要求到完整稿件" },
  { name: "评论与弹幕", icon: MessageSquare, description: "理解正文，生成互动内容" },
  { name: "发布工具", icon: SlidersHorizontal, description: "准备标题与发布文案" },
  { name: "图片与素材", icon: Image, description: "处理画面、图片与转写" }
].map(group => ({ ...group, policies: AI_POLICIES.filter(p => p.group === group.name && !("retired" in p && p.retired)) }));

function PolicySettings() {
  const w = useAiSettings();
  return <div className="ai-settings-board" aria-busy={w.loading || w.saving}>
      <div className="ai-settings-toolbar">
        <div><SlidersHorizontal size={16} aria-hidden="true" /><span>按创作环节配置</span><span className="ai-settings-total">{groups.reduce((count, group) => count + group.policies.length, 0)} 个环节</span></div>
        <span className="ai-settings-hint">{w.loading ? "正在读取配置…" : w.dirty ? `${w.dirtyIds.length} 项待应用` : "修改后逐项应用"}</span>
      </div>
      {w.error && <p role="alert" className="ai-settings-notice error">{w.error} <button className="btn compact" type="button" onClick={() => void w.load()}>重试</button></p>}
      {w.loading && !w.saved && <div className="ai-settings-loading" role="status"><span className="sr-only">正在读取模型配置</span>{groups.slice(0, 3).map(group => <div key={group.name}><span /><span /></div>)}</div>}
      {w.saved && <div className="ai-policy-list">
        {groups.map((group, index) => <section key={group.name} className="ai-policy-group" aria-labelledby={`ai-group-${index}`}>
          <header className="ai-policy-group-heading">
            <div><group.icon size={18} aria-hidden="true" /><h2 id={`ai-group-${index}`}>{group.name}</h2><span className="ai-policy-count">{group.policies.length}</span></div>
            <p>{group.description}</p>
          </header>
          <div className="ai-policy-fields">
            <div className="ai-policy-columns" aria-hidden="true"><span>业务环节</span><span>模型</span><span>推理强度</span></div>
          {group.policies.map(policy => {
            const isImage = "kind" in policy;
            const value = w.overrides[policy.id] || w.saved!.defaults[policy.id];
            const models = isImage ? w.saved!.models.filter(model => model.startsWith("gpt-image")) : [...new Set([...Object.keys(modelLabels), value.model, w.saved!.inheritedModels[policy.id]].filter(Boolean))];
            const model = value.model || w.saved!.inheritedModels[policy.id];
            const effort = value.effort === "default" ? w.saved!.inheritedEfforts[policy.id] : value.effort;
            const dirty = w.dirtyIds.includes(policy.id);
            return <div className={`ai-policy-row${dirty ? " is-dirty" : ""}`} key={policy.id}>
              <div className="ai-policy-name"><strong>{policy.title}</strong><p>{policy.description}</p></div>
              <label htmlFor={`ai-model-${policy.id}`}><span>模型</span><WorkbenchSelect id={`ai-model-${policy.id}`} aria-label={`${policy.title}中转模型`} disabled={w.saving} value={model} onValueChange={next => w.change([policy.id], { model: next })}>
                {models.map(item => <option key={item} value={item}>{modelLabels[item] || item}</option>)}
              </WorkbenchSelect></label>
              <label htmlFor={`ai-effort-${policy.id}`}><span>推理强度</span><WorkbenchSelect id={`ai-effort-${policy.id}`} aria-label={`${policy.title}中转推理强度`} disabled={isImage || w.saving} value={isImage ? "none" : effort} onValueChange={next => w.change([policy.id], { effort: next as AiEffort })}>
                {isImage ? <option value="none">不适用</option> : AI_EFFORTS.filter(item => item !== "none").map(item => <option key={item} value={item}>{effortLabels[item]}</option>)}
              </WorkbenchSelect></label>
              {dirty && <div className="ai-policy-actions"><span>此项有未应用的修改</span><button className="btn compact" type="button" aria-label={`恢复${policy.title}默认配置`} disabled={w.saving} onClick={() => w.change([policy.id], null)}><RotateCcw size={14} aria-hidden="true" />恢复默认</button><button className="btn primary compact" type="button" aria-label={`应用${policy.title}配置`} disabled={w.saving} onClick={() => void w.save(policy.id)}><Check size={14} aria-hidden="true" />{w.saving ? "应用中…" : "应用"}</button></div>}
              {w.itemErrors[policy.id] && <p role="alert" className="ai-policy-error">{w.itemErrors[policy.id]}</p>}
            </div>;
          })}</div></section>)}
      </div>}
      {w.message && <span role="status" className="ai-settings-saved"><Check size={16} aria-hidden="true" />{w.message}，新请求将使用最新配置</span>}
    </div>;
}

export default function AiSettingsPage() {
  return <div className="page ai-settings-page"><h1 className="sr-only">AI 模型配置</h1><PolicySettings /></div>;
}
