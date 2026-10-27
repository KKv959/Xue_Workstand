"use client";

import { Monitor, Music2, Play, Search } from "lucide-react";
import { WorkbenchSelect } from "@/components/WorkbenchSelect";
import type { CollectOrder, Platform } from "@/lib/types";
import { timeRangeOptions, type TimeRange } from "./library-collect-utils";

type LibraryQuickStartPanelProps = {
  activeOrderOptions: Array<{ value: CollectOrder; label: string }>;
  busy: string;
  canSubmit: boolean;
  customFromDate: string;
  customToDate: string;
  limit: number;
  name: string;
  order: CollectOrder;
  platform: Platform;
  timeRange: TimeRange;
  onCollect: () => void;
  onCustomFromDateChange: (value: string) => void;
  onCustomToDateChange: (value: string) => void;
  onLimitChange: (value: number) => void;
  onNameChange: (value: string) => void;
  onOrderChange: (value: CollectOrder) => void;
  onPlatformChange: (value: Platform) => void;
  onTimeRangeChange: (value: TimeRange) => void;
};

export function LibraryQuickStartPanel({
  activeOrderOptions,
  busy,
  canSubmit,
  customFromDate,
  customToDate,
  limit,
  name,
  order,
  platform,
  timeRange,
  onCollect,
  onCustomFromDateChange,
  onCustomToDateChange,
  onLimitChange,
  onNameChange,
  onOrderChange,
  onPlatformChange,
  onTimeRangeChange
}: LibraryQuickStartPanelProps) {
  return (
    <section id="library-collect-panel" className="panel library-quick-start workbench-leading-panel advanced-open" aria-label="账号采集">
      <form
        className="library-quick-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onCollect();
        }}
      >
        <div className="library-quick-fields">
          <CollectControls
            activeOrderOptions={activeOrderOptions}
            customFromDate={customFromDate}
            customToDate={customToDate}
            limit={limit}
            name={name}
            order={order}
            platform={platform}
            timeRange={timeRange}
            onCustomFromDateChange={onCustomFromDateChange}
            onCustomToDateChange={onCustomToDateChange}
            onLimitChange={onLimitChange}
            onNameChange={onNameChange}
            onOrderChange={onOrderChange}
            onPlatformChange={onPlatformChange}
            onTimeRangeChange={onTimeRangeChange}
          />
        </div>
        <div className="library-quick-actions">
          <button className="btn primary library-collect-submit" aria-busy={busy === "collect"} disabled={!canSubmit} type="submit">
            <Play aria-hidden="true" size={16} />
            {busy === "collect" ? "采集中" : "采集"}
          </button>
        </div>
      </form>
    </section>
  );
}

function CollectControls({
  activeOrderOptions,
  customFromDate,
  customToDate,
  limit,
  name,
  order,
  platform,
  timeRange,
  onCustomFromDateChange,
  onCustomToDateChange,
  onLimitChange,
  onNameChange,
  onOrderChange,
  onPlatformChange,
  onTimeRangeChange
}: Pick<
  LibraryQuickStartPanelProps,
  | "activeOrderOptions"
  | "customFromDate"
  | "customToDate"
  | "limit"
  | "name"
  | "order"
  | "platform"
  | "timeRange"
  | "onCustomFromDateChange"
  | "onCustomToDateChange"
  | "onLimitChange"
  | "onNameChange"
  | "onOrderChange"
  | "onPlatformChange"
  | "onTimeRangeChange"
>) {
  return (
    <>
      <div className="field library-platform-field">
        <span id="collect-platform-label">平台</span>
        <div aria-labelledby="collect-platform-label" className="segmented library-platform-segmented" role="group">
          <button
            aria-pressed={platform === "bilibili"}
            className={platform === "bilibili" ? "active" : ""}
            onClick={() => onPlatformChange("bilibili")}
            type="button"
          >
            <Monitor aria-hidden="true" size={14} />
            B站
          </button>
          <button
            aria-pressed={platform === "douyin"}
            className={platform === "douyin" ? "active" : ""}
            onClick={() => onPlatformChange("douyin")}
            type="button"
          >
            <Music2 aria-hidden="true" size={14} />
            抖音
          </button>
        </div>
      </div>
      <div className="field library-account-name-field">
        <label htmlFor="collect-account-name">账号名 / 主页链接</label>
        <div className="input-with-icon">
          <Search aria-hidden="true" size={16} />
          <input
            autoComplete="off"
            id="collect-account-name"
            name="accountName"
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={platform === "douyin" ? "例如：老青椒、主页链接或 sec_uid…" : "例如：某某UP主、空间链接或 UID…"}
            value={name}
          />
        </div>
      </div>
      <div
        aria-label="采集设置"
        className={`library-quick-advanced ${timeRange === "custom" ? "custom-range" : ""}`}
        id="library-collect-advanced"
        role="group"
      >
        <div className="library-quick-advanced-fields">
          <div className="field">
            <label htmlFor="collect-limit">数量</label>
            <input autoComplete="off" id="collect-limit" inputMode="numeric" max={50} min={1} name="limit" onChange={(event) => updateBoundedNumber(event.target.value, 1, 50, onLimitChange)} type="number" value={limit} />
          </div>
          <div className="field">
            <label htmlFor="collect-order">采集排序</label>
            <WorkbenchSelect aria-label="采集排序" id="collect-order" name="order" onValueChange={(value) => onOrderChange(value as CollectOrder)} value={order}>
              {activeOrderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </WorkbenchSelect>
          </div>
          <div className="field">
            <label htmlFor="collect-time-range">采集时间</label>
            <WorkbenchSelect aria-label="采集时间" id="collect-time-range" name="timeRange" onValueChange={(value) => onTimeRangeChange(value as TimeRange)} value={timeRange}>
              {timeRangeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </WorkbenchSelect>
          </div>
          {timeRange === "custom" ? (
            <>
              <div className="field">
                <label htmlFor="collect-from-date">开始日期</label>
                <input
                  autoComplete="off"
                  id="collect-from-date"
                  name="fromDate"
                  onChange={(event) => onCustomFromDateChange(event.target.value)}
                  type="date"
                  value={customFromDate}
                />
              </div>
              <div className="field">
                <label htmlFor="collect-to-date">结束日期</label>
                <input
                  autoComplete="off"
                  id="collect-to-date"
                  name="toDate"
                  onChange={(event) => onCustomToDateChange(event.target.value)}
                  type="date"
                  value={customToDate}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

function updateBoundedNumber(value: string, min: number, max: number, onChange: (value: number) => void) {
  if (!value.trim()) return;
  const next = Number(value);
  if (!Number.isFinite(next)) return;
  onChange(Math.min(Math.max(Math.trunc(next), min), max));
}
