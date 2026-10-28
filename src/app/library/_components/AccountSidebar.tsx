"use client";

import { memo } from "react";
import { CheckCircle2, CircleDashed, ListChecks, Music2, Search, Trash2, TvMinimal, X } from "lucide-react";
import { formatPlatform } from "@/components/Formatters";
import type { AccountListItem } from "@/lib/types";

type AccountSidebarProps = {
  accountFilter: string;
  accountManageMode: boolean;
  accounts: AccountListItem[];
  busy: string;
  loading: boolean;
  selectedAccountId: string;
  selectedAccountIds: string[];
  onAccountFilterChange: (value: string) => void;
  onClearFilters: () => void;
  onRequestDeleteAccounts: () => void;
  onSelectAccount: (accountId: string) => void;
  onToggleAccountManage: () => void;
  onToggleAllAccounts: () => void;
  onToggleManagedAccount: (accountId: string) => void;
};

export const AccountSidebar = memo(function AccountSidebar({
  accountFilter,
  accountManageMode,
  accounts,
  busy,
  loading,
  selectedAccountId,
  selectedAccountIds,
  onAccountFilterChange,
  onClearFilters,
  onRequestDeleteAccounts,
  onSelectAccount,
  onToggleAccountManage,
  onToggleAllAccounts,
  onToggleManagedAccount
}: AccountSidebarProps) {
  const allVisibleSelected = Boolean(accounts.length && accounts.every((account) => selectedAccountIds.includes(account.id)));
  return (
    <aside aria-busy={loading} className={`pane account-sidebar ${accountManageMode ? "selection-mode" : ""}`}>
      <div className="pane-header">
        <div>
          <h2>{accountManageMode ? "选择账号" : "账号"}</h2>
        </div>
        <div className="account-manage-actions">
          <button
            className="btn compact account-manage-toggle"
            aria-label={accountManageMode ? "退出账号选择" : "批量选择账号"}
            onClick={onToggleAccountManage}
            title={accountManageMode ? "退出选择" : "批量选择"}
            type="button"
          >
            {accountManageMode ? <X aria-hidden="true" size={15} /> : <ListChecks aria-hidden="true" size={15} />}
            {accountManageMode ? "取消" : "多选"}
          </button>
        </div>
      </div>
      {accountManageMode ? (
        <div className="selection-toolbar" role="toolbar" aria-label="账号批量操作">
          <button className="btn compact" disabled={!accounts.length} onClick={onToggleAllAccounts} type="button">
            {allVisibleSelected ? "清空" : "全选"}
          </button>
          <div className="selection-copy" aria-live="polite">
            <strong>已选 {selectedAccountIds.length} 个</strong>
          </div>
          <button
            className="btn danger compact"
            disabled={!selectedAccountIds.length || busy === "account-delete"}
            onClick={onRequestDeleteAccounts}
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} />
            {busy === "account-delete" ? "删除中" : "删除"}
          </button>
        </div>
      ) : null}
      <div className="pane-search account-filter-stack">
        <div className="search-control filter-search">
          <Search aria-hidden="true" size={15} />
          <input
            aria-label="搜索账号"
            autoComplete="off"
            name="accountFilter"
            value={accountFilter}
            onChange={(event) => onAccountFilterChange(event.target.value)}
            placeholder="搜索账号…"
            type="search"
          />
        </div>
      </div>
      <div className="pane-body">
        {accounts.map((account) => {
          const selected = selectedAccountId === account.id;
          const managed = selectedAccountIds.includes(account.id);
          return (
            <button
              aria-current={!accountManageMode && selected ? "true" : undefined}
              aria-pressed={accountManageMode ? managed : undefined}
              className={`list-button account-list-button ${!accountManageMode && selected ? "active" : ""} ${accountManageMode && managed ? "checked" : ""}`}
              key={account.id}
              onClick={() => accountManageMode ? onToggleManagedAccount(account.id) : onSelectAccount(account.id)}
              type="button"
            >
              {accountManageMode ? <span className={`check-dot ${managed ? "checked" : ""}`} aria-hidden="true" /> : null}
              <span className={`account-avatar tone-${getAvatarTone(account.id)} ${account.avatarUrl ? "has-image" : ""}`} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {account.avatarUrl ? <img alt="" height={30} referrerPolicy="no-referrer" src={account.avatarUrl} width={30} /> : null}
                {getAccountInitial(account.name)}
              </span>
              <span className="account-list-copy">
                <span className="list-title">{account.name}</span>
                <span className="account-list-badges">
                  <span className={`account-platform-label ${account.platform}`}>
                    {account.platform === "douyin" ? <Music2 size={11} aria-hidden="true" /> : <TvMinimal size={11} aria-hidden="true" />}
                    {formatPlatform(account.platform)}
                  </span>
                  <span className={`status-pill ${!account.videoCount ? "" : account.missingTranscriptCount ? "pending" : "done"}`}>
                    {account.videoCount && !account.missingTranscriptCount ? <CheckCircle2 size={11} aria-hidden="true" /> : <CircleDashed size={11} aria-hidden="true" />}
                    {!account.videoCount ? "暂无视频" : account.missingTranscriptCount ? `待转写 ${account.missingTranscriptCount}` : "转写已齐"}
                  </span>
                </span>
                <span className="account-list-flags">
                  <span>{account.videoCount} 视频</span>
                  {account.styleStatus === "not_generated" ? <span className="status-text warning">待生成风格</span> : null}
                  {account.styleStatus === "fallback" ? <span className="status-text warning">降级风格</span> : null}
                  {account.lastCollectedAt ? <span>采集 {formatShortDate(account.lastCollectedAt)}</span> : <span>尚未采集</span>}
                </span>
              </span>
            </button>
          );
        })}
        {loading ? (
          <div className="library-loading-list" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, index) => <span className="library-loading-row account" key={index} />)}
          </div>
        ) : null}
        {!loading && !accounts.length ? (
          <div className="library-filter-empty">
            <p className="subtle">没有匹配的账号。</p>
            <button className="btn compact" onClick={onClearFilters} type="button">清除搜索</button>
          </div>
        ) : null}
      </div>
    </aside>
  );
});

function getAccountInitial(name: string) {
  return Array.from(name.trim()).at(0)?.toLocaleUpperCase("zh-CN") || "账";
}

function getAvatarTone(id: string) {
  return Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 8;
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(+date)) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}
