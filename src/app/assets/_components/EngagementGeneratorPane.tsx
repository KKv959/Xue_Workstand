"use client";

import { useState, type CSSProperties } from "react";
import { Send } from "lucide-react";
import type { BusyState } from "./asset-view-utils";
import { SourceInput } from "./SourceInput";
import type { Platform } from "@/lib/types";

type EngagementGeneratorPaneProps = {
  busy: BusyState;
  canGenerate: boolean;
  commentCount: number;
  danmakuCount: number;
  includeComments: boolean;
  includeDanmaku: boolean;
  generationProgress: {
    stage: string;
    message: string;
    progress: number;
  } | null;
  targetPlatform: Platform;
  supportsDanmaku: boolean;
  sourceInput: string;
  onCommentCountChange: (count: number) => void;
  onDanmakuCountChange: (count: number) => void;
  onGenerate: () => void;
  onTargetPlatformChange: (platform: Platform) => void;
  onIncludeCommentsChange: (enabled: boolean) => void;
  onIncludeDanmakuChange: (enabled: boolean) => void;
  onSourceInputChange: (value: string) => void;
};

export function EngagementGeneratorPane({
  busy,
  canGenerate,
  commentCount,
  danmakuCount,
  includeComments,
  includeDanmaku,
  generationProgress,
  targetPlatform,
  supportsDanmaku,
  sourceInput,
  onCommentCountChange,
  onDanmakuCountChange,
  onGenerate,
  onTargetPlatformChange,
  onIncludeCommentsChange,
  onIncludeDanmakuChange,
  onSourceInputChange
}: EngagementGeneratorPaneProps) {
  const sliderCommentCount = Math.min(200, Math.max(5, Math.round(commentCount / 5) * 5));
  const sliderProgress = ((sliderCommentCount - 5) / (200 - 5)) * 100;

  return (
    <section className="engagement-generator-pane">
      <div className="pane-body engagement-generator-body">
        <SourceInput value={sourceInput} onChange={onSourceInputChange} />

        <section className="engagement-form-section engagement-options-panel">
          <div className="engagement-form-heading">
            <h3>生成设置</h3>
          </div>
          <div className="engagement-chain-summary" aria-label="评论生成链路">
            <strong>正文驱动</strong>
            <span>读取正文</span>
            <span>精准采样</span>
            <span>语料审查</span>
            <span>AI 创作</span>
            <span>保存结果</span>
          </div>
          <div className="engagement-mode-row">
            <span className="field-label">目标平台</span>
            <div aria-label="选择粘贴文案的目标平台" className="segmented engagement-mode-segmented engagement-platform-segmented" role="group">
              <button
                aria-pressed={targetPlatform === "douyin"}
                className={targetPlatform === "douyin" ? "active" : ""}
                disabled={busy === "generate"}
                onClick={() => onTargetPlatformChange("douyin")}
                title="视频链接会自动识别；此选项用于粘贴文案"
                type="button"
              >
                抖音
              </button>
              <button
                aria-pressed={targetPlatform === "bilibili"}
                className={targetPlatform === "bilibili" ? "active" : ""}
                disabled={busy === "generate"}
                onClick={() => onTargetPlatformChange("bilibili")}
                title="视频链接会自动识别；此选项用于粘贴文案"
                type="button"
              >
                B站
              </button>
            </div>
          </div>
          <fieldset className="engagement-output-fieldset">
            <legend className="field-label">生成内容</legend>
            <div className="engagement-option-list">
              <label className={`engagement-option ${includeComments ? "active" : ""}`}>
                <input checked={includeComments} name="includeComments" type="checkbox" onChange={(event) => onIncludeCommentsChange(event.target.checked)} />
                <span>
                  <strong>评论</strong>
                  <small>默认生成评论</small>
                </span>
              </label>
              <label className={`engagement-option ${includeDanmaku ? "active" : ""} ${supportsDanmaku ? "" : "is-disabled"}`}>
                <input checked={includeDanmaku} disabled={!supportsDanmaku} name="includeDanmaku" type="checkbox" onChange={(event) => onIncludeDanmakuChange(event.target.checked)} />
                <span>
                  <strong>弹幕</strong>
                  <small>{supportsDanmaku ? "B站 · 围绕正文批量生成" : "仅支持 B站"}</small>
                </span>
                <BoundedNumberInput
                  ariaLabel="弹幕条数"
                  disabled={!includeDanmaku || !supportsDanmaku}
                  max={300}
                  min={1}
                  name="danmakuCount"
                  value={danmakuCount}
                  onChange={onDanmakuCountChange}
                />
              </label>
            </div>
          </fieldset>
          <div className="engagement-settings-footer">
            <div className="engagement-count-slider-field">
              <label className="field-label" htmlFor="engagement-comment-count-slider">评论条数</label>
              <div className="engagement-count-slider-control">
                <span aria-hidden="true">5</span>
                <input
                  aria-label="评论条数滑块"
                  aria-valuetext={`${sliderCommentCount} 条`}
                  className="engagement-count-slider"
                  disabled={!includeComments}
                  id="engagement-comment-count-slider"
                  max={200}
                  min={5}
                  step={5}
                  type="range"
                  value={sliderCommentCount}
                  style={{ "--engagement-slider-progress": `${sliderProgress}%` } as CSSProperties}
                  onChange={(event) => onCommentCountChange(Number(event.currentTarget.value))}
                />
                <span aria-hidden="true">200</span>
                <output aria-live="polite" htmlFor="engagement-comment-count-slider">{sliderCommentCount} 条</output>
              </div>
            </div>
            <button className="btn primary engagement-submit" disabled={!canGenerate} onClick={onGenerate} type="button">
              <Send aria-hidden="true" size={16} />
              {busy === "generate" ? "正在生成" : "生成评论"}
            </button>
          </div>
          {generationProgress ? (
            <div className="engagement-generation-progress" role="status" aria-live="polite" aria-busy="true">
              <div>
                <strong>{progressStageLabel(generationProgress.stage)}</strong>
                <span>{generationProgress.message}</span>
              </div>
              <div aria-hidden="true" className="engagement-progress-track">
                <span style={{ width: `${Math.min(100, Math.max(0, generationProgress.progress))}%` }} />
              </div>
            </div>
          ) : null}
        </section>

      </div>
    </section>
  );
}

function progressStageLabel(stage: string) {
  if (stage === "source") return "读取目标视频正文";
  if (stage === "brief") return "提取人物、事件与桥段";
  if (stage === "research") return "采集并检查平台语料";
  if (stage === "generate") return "批量生成互动素材";
  if (stage === "filter") return "保存生成结果";
  return "评论生成中";
}

type BoundedNumberInputProps = {
  ariaLabel: string;
  disabled: boolean;
  max: number;
  min: number;
  name: string;
  value: number;
  onChange: (value: number) => void;
};

function BoundedNumberInput({
  ariaLabel,
  disabled,
  max,
  min,
  name,
  value,
  onChange
}: BoundedNumberInputProps) {
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const displayedValue = draftValue ?? String(value);

  function commitValue(rawValue: string) {
    const nextValue = normalizeBoundedNumber(rawValue, min, max, value);
    setDraftValue(null);
    if (nextValue !== value) onChange(nextValue);
  }

  return (
    <input
      aria-label={ariaLabel}
      autoComplete="off"
      disabled={disabled}
      inputMode="numeric"
      max={max}
      min={min}
      name={name}
      step={1}
      title={`请输入 ${min}–${max} 之间的整数`}
      type="number"
      value={displayedValue}
      onBlur={(event) => commitValue(event.currentTarget.value)}
      onChange={(event) => {
        const nextDraft = event.currentTarget.value;
        setDraftValue(nextDraft);
        const nextValue = readValidBoundedNumber(nextDraft, min, max);
        if (nextValue !== null && nextValue !== value) onChange(nextValue);
      }}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.currentTarget.blur();
      }}
    />
  );
}

function readValidBoundedNumber(rawValue: string, min: number, max: number) {
  if (!rawValue.trim()) return null;
  const nextValue = Number(rawValue);
  if (!Number.isInteger(nextValue) || nextValue < min || nextValue > max) return null;
  return nextValue;
}

function normalizeBoundedNumber(rawValue: string, min: number, max: number, fallback: number) {
  if (!rawValue.trim()) return fallback;
  const nextValue = Number(rawValue);
  if (!Number.isFinite(nextValue)) return fallback;
  return Math.min(Math.max(Math.trunc(nextValue), min), max);
}
