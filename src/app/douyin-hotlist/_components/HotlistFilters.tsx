"use client";

import { WorkbenchSelect } from "@/components/WorkbenchSelect";

import type { DouyinHotlistAccount, Platform } from "@/lib/types";
import {
  getPlatformAccountSelection,
  getPlatformLabel,
  windowOptions,
  type AccountSelection,
  type WindowFilter
} from "../_lib/douyin-hotlist-model";

export function AccountFilter({
  accounts,
  disabled,
  onChange,
  value
}: {
  accounts: DouyinHotlistAccount[];
  disabled: boolean;
  onChange: (value: AccountSelection) => void;
  value: AccountSelection;
}) {
  return (
    <label className="inline-sort-control douyin-hotlist-account-filter">
      <span>账号</span>
      <WorkbenchSelect aria-label="筛选对标账号" disabled={disabled} onValueChange={(value) => onChange(value)} value={value}>
        <option value="all">全部账号</option>
        <option value={getPlatformAccountSelection("douyin")}>全部抖音账号</option>
        <option value={getPlatformAccountSelection("bilibili")}>全部 B站账号</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>{getPlatformLabel(account.platform)} · {account.name}</option>
        ))}
      </WorkbenchSelect>
    </label>
  );
}

export function WindowFilterControl({
  disabled,
  onChange,
  value
}: {
  disabled: boolean;
  onChange: (value: WindowFilter) => void;
  value: WindowFilter;
}) {
  return (
    <div className="segmented-control douyin-hotlist-window-filter" aria-label="时间筛选">
      {windowOptions.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={value === option.value ? "active" : ""}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PlatformFilterControl({
  disabled,
  onChange,
  value
}: {
  disabled: boolean;
  onChange: (value: Platform | "all") => void;
  value: Platform | "all";
}) {
  const options: Array<{ label: string; value: Platform | "all" }> = [
    { label: "全部", value: "all" },
    { label: "抖音", value: "douyin" },
    { label: "B站", value: "bilibili" }
  ];

  return (
    <div className="segmented-control douyin-hotlist-platform-filter" aria-label="平台筛选">
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={value === option.value ? "active" : ""}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
