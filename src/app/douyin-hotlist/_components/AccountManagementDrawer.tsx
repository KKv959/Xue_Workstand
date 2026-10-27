"use client";

import { Plus, Trash2, Users, X } from "lucide-react";
import { useMemo, useRef, type FormEvent } from "react";
import { ModalBackdrop } from "@/components/ModalBackdrop";
import type { DouyinHotlistAccount, DouyinHotlistResponse, Platform } from "@/lib/types";
import {
  getAccountInputPlaceholder,
  getAvatarTone,
  getPlatformAccountSelection,
  getPlatformLabel,
  type AccountSelection,
  type BusyState
} from "../_lib/douyin-hotlist-model";
import { AccountAvatarImage, PlatformLogoBadge } from "./HotlistIdentity";

export function AccountManagementDrawer({
  accounts,
  accountPlatform,
  busy,
  canAdd,
  disabled,
  initialLoading,
  query,
  selectedAccountId,
  summary,
  windowLabel,
  onAddAccount,
  onClose,
  onPlatformChange,
  onQueryChange,
  onRemoveAccount,
  onSelectAccount
}: {
  accounts: DouyinHotlistAccount[];
  accountPlatform: Platform;
  busy: BusyState;
  canAdd: boolean;
  disabled: boolean;
  initialLoading: boolean;
  query: string;
  selectedAccountId: AccountSelection;
  summary?: DouyinHotlistResponse["summary"];
  windowLabel: string;
  onAddAccount: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  onPlatformChange: (platform: Platform) => void;
  onQueryChange: (value: string) => void;
  onRemoveAccount: (account: DouyinHotlistAccount) => void;
  onSelectAccount: (value: AccountSelection) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const locked = busy === "add" || busy.startsWith("remove:");
  const platformLabel = getPlatformLabel(accountPlatform);
  const visibleAccounts = useMemo(
    () => accounts.filter((account) => account.platform === accountPlatform),
    [accounts, accountPlatform]
  );
  const visibleRecentVideoCount = visibleAccounts.reduce((sum, account) => sum + account.recentVideoCount, 0);
  const platformSelection = getPlatformAccountSelection(accountPlatform);

  return (
    <ModalBackdrop
      disabled={locked}
      onClose={onClose}
      initialFocusRef={inputRef}
      aria-labelledby="douyin-hotlist-account-drawer-title"
      className="douyin-hotlist-account-drawer"
    >
        <header className="douyin-hotlist-account-drawer-header">
          <div>
            <h2 id="douyin-hotlist-account-drawer-title">管理账号</h2>
            <p>{summary ? `${summary.accountCount} 个账号 · ${windowLabel} ${summary.recentVideoCount} 条` : "独立热榜账号池"}</p>
          </div>
          <button aria-label="关闭账号管理" className="btn icon-only compact" disabled={locked} onClick={onClose} type="button">
            <X aria-hidden="true" size={15} />
          </button>
        </header>

        <form className="douyin-hotlist-drawer-add-form" onSubmit={onAddAccount}>
          <label htmlFor="douyin-hotlist-drawer-query">账号名 / 主页链接</label>
          <PlatformSwitch disabled={disabled} onChange={onPlatformChange} value={accountPlatform} />
          <div className="douyin-hotlist-add-row">
            <input
              autoComplete="off"
              disabled={disabled}
              id="douyin-hotlist-drawer-query"
              name="query"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={getAccountInputPlaceholder(accountPlatform)}
              ref={inputRef}
              value={query}
            />
            <button className="btn primary icon-only" disabled={!canAdd} type="submit" aria-label={`添加${getPlatformLabel(accountPlatform)}账号`}>
              <Plus aria-hidden="true" size={17} />
            </button>
          </div>
        </form>

        <div className="douyin-hotlist-drawer-body" aria-label={`已关注${platformLabel}账号`}>
          {initialLoading ? (
            <HotlistAccountLoadingRows />
          ) : visibleAccounts.length ? (
            <>
              <AccountRowAll
                active={selectedAccountId === platformSelection}
                accountCount={visibleAccounts.length}
                label={`全部${platformLabel}账号`}
                recentVideoCount={visibleRecentVideoCount}
                windowLabel={windowLabel}
                onSelect={() => onSelectAccount(platformSelection)}
              />
              {visibleAccounts.map((account) => (
                <AccountRow
                  account={account}
                  active={selectedAccountId === account.id}
                  busy={disabled || busy === `remove:${account.id}`}
                  key={account.id}
                  windowLabel={windowLabel}
                  onRemove={() => onRemoveAccount(account)}
                  onSelect={() => onSelectAccount(account.id)}
                />
              ))}
            </>
          ) : (
            <div className="douyin-hotlist-empty-inline">
              <Users aria-hidden="true" size={17} />
              <span>还没有{platformLabel}对标账号。</span>
            </div>
          )}
        </div>
    </ModalBackdrop>
  );
}

function PlatformSwitch({
  disabled,
  onChange,
  value
}: {
  disabled: boolean;
  onChange: (value: Platform) => void;
  value: Platform;
}) {
  return (
    <div className="segmented-control douyin-hotlist-platform-switch" aria-label="选择账号平台">
      {(["douyin", "bilibili"] as const).map((platform) => (
        <button
          aria-pressed={value === platform}
          className={value === platform ? "active" : ""}
          disabled={disabled}
          key={platform}
          onClick={() => onChange(platform)}
          type="button"
        >
          {getPlatformLabel(platform)}
        </button>
      ))}
    </div>
  );
}

function HotlistAccountLoadingRows() {
  return (
    <div className="douyin-hotlist-skeleton-list" aria-label="正在读取对标账号">
      {Array.from({ length: 5 }).map((_, index) => (
        <span className="douyin-hotlist-account-skeleton" key={index} />
      ))}
    </div>
  );
}

function AccountRowAll({
  accountCount,
  active,
  label,
  onSelect,
  recentVideoCount,
  windowLabel
}: {
  accountCount: number;
  active: boolean;
  label: string;
  onSelect: () => void;
  recentVideoCount: number;
  windowLabel: string;
}) {
  return (
    <div className={`list-button account-list-button douyin-hotlist-account-row all-row ${active ? "active" : ""}`}>
      <button aria-pressed={active} className="douyin-hotlist-account-select" onClick={onSelect} type="button">
        <span className="account-avatar tone-7" aria-hidden="true">
          <Users size={15} strokeWidth={2.1} />
        </span>
        <span className="account-list-copy">
          <span className="list-title">{label}</span>
          <span className="list-meta">{windowLabel} {recentVideoCount} · {accountCount} 个账号</span>
        </span>
      </button>
    </div>
  );
}

function AccountRow({
  account,
  active,
  busy,
  windowLabel,
  onRemove,
  onSelect
}: {
  account: DouyinHotlistAccount;
  active: boolean;
  busy: boolean;
  windowLabel: string;
  onRemove: () => void;
  onSelect: () => void;
}) {
  return (
    <div className={`list-button account-list-button douyin-hotlist-account-row ${active ? "active" : ""}`}>
      <button aria-pressed={active} className="douyin-hotlist-account-select" onClick={onSelect} type="button">
        <span
          className={`account-avatar tone-${getAvatarTone(account.id)} ${account.avatarUrl ? "has-image" : ""}`}
          aria-hidden="true"
        >
          <AccountAvatarImage account={account} size={30} />
        </span>
        <span className="account-list-copy">
          <span className="list-title">
            <PlatformLogoBadge platform={account.platform} />
            <span className="douyin-hotlist-account-name">{account.name}</span>
          </span>
          <span className="list-meta">{windowLabel} {account.recentVideoCount} · 累计 {account.videoCount}</span>
        </span>
      </button>
      <button
        aria-label={`移除 ${account.name}`}
        className="btn icon-only compact douyin-hotlist-account-remove mobile-destructive-action"
        disabled={busy}
        onClick={onRemove}
        title="移出热榜账号池"
        type="button"
      >
        <Trash2 aria-hidden="true" size={15} />
      </button>
    </div>
  );
}
