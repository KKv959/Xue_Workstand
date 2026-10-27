"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { Check, FolderOpen, Search, Users, X } from "lucide-react";
import { ListBox, ListBoxItem } from "react-aria-components";
import { WorkbenchSelect } from "@/components/WorkbenchSelect";
import { AccountAvatarImage } from "./HotlistIdentity";
import { ModalBackdrop } from "@/components/ModalBackdrop";
import { saveDouyinHotlistGroup } from "@/lib/client";
import type { DouyinHotlistGroup, DouyinHotlistResponse } from "@/lib/types";
import { getPlatformLabel } from "../_lib/douyin-hotlist-model";

export function HotlistGroupEditor({ group, snapshot, windowFilter, onClose, onSaved }: {
  group?: DouyinHotlistGroup;
  snapshot: DouyinHotlistResponse;
  windowFilter: string;
  onClose: () => void;
  onSaved: (snapshot: DouyinHotlistResponse, groupId: string) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(group?.name ?? "");
  const [accountIds, setAccountIds] = useState(group?.accountIds ?? []);
  const [revision] = useState(snapshot.groupRevision ?? 0);
  const [accounts] = useState(snapshot.accounts);
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const selected = useMemo(() => new Set(accountIds), [accountIds]);
  const visible = useMemo(() => accounts.filter((account) => (platform === "all" || account.platform === platform) && `${account.name} ${getPlatformLabel(account.platform)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [accounts, platform, query]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await saveDouyinHotlistGroup({ groupId: group?.id, name: name.trim(), accountIds, revision, window: windowFilter });
      const saved = next.groups?.find((item) => group ? item.id === group.id : item.name === name.trim());
      if (!saved) throw new Error("分组保存后未能读取，请关闭弹窗并重载确认。");
      onSaved(next, saved.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存分组失败，请重试。");
    } finally { savingRef.current = false; setBusy(false); }
  }

  return <ModalBackdrop className="modal-panel hotlist-group-editor" aria-labelledby="hotlist-group-editor-title" disabled={busy} initialFocusRef={nameRef} onClose={onClose}>
    <header className="hotlist-group-editor-header">
      <span className="hotlist-group-editor-icon" aria-hidden="true"><FolderOpen size={21} strokeWidth={1.75} /></span>
      <div><h2 id="hotlist-group-editor-title">{group ? "编辑监控分组" : "新建监控分组"}</h2><p className="subtle">把关注的账号放在一起，按主题查看动态。</p></div>
      <button type="button" className="btn ghost icon-only compact" aria-label="关闭分组编辑" disabled={busy} onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <form onSubmit={(event) => void save(event)} aria-busy={busy}>
      <div className="hotlist-group-editor-body">
        <label className="field hotlist-group-name"><span>分组名称 <small aria-hidden="true">{name.length}/40</small></span>
          <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} required disabled={busy} placeholder="例如：美食探店、家居品牌、行业对标" />
        </label>
        <div className="hotlist-group-member-heading"><div><span id="hotlist-group-accounts-label">选择监控账号</span><p className="subtle">同一账号可以加入多个分组，不会影响其他分组。</p></div><span className="status-pill" aria-live="polite">已选 {accountIds.length}</span></div>
        <div className="hotlist-group-picker">
          <div className="hotlist-group-picker-tools">
            <label className="hotlist-group-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索分组账号" placeholder="搜索账号名称" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
            <WorkbenchSelect aria-label="分组账号平台" value={platform} onValueChange={setPlatform} disabled={busy}>
              <option value="all">全部平台</option><option value="douyin">抖音</option><option value="bilibili">B站</option>
            </WorkbenchSelect>
          </div>
          <ListBox className="hotlist-group-members" aria-labelledby="hotlist-group-accounts-label" selectionMode="multiple" selectionBehavior="toggle"
            selectedKeys={selected} disabledKeys={busy ? accounts.map((account) => account.id) : []}
            onSelectionChange={(keys) => {
              const next = keys === "all" ? visible.map((account) => account.id) : [...keys].map(String);
              const visibleIds = new Set(visible.map((account) => account.id));
              setAccountIds([...new Set([...accountIds.filter((id) => !visibleIds.has(id)), ...next])]);
            }}
            items={visible}
            renderEmptyState={() => <div className="hotlist-group-picker-empty"><Users size={24} strokeWidth={1.5} aria-hidden="true" /><strong>{accounts.length ? "没有找到匹配账号" : "还没有监控账号"}</strong><p>{accounts.length ? "试试其他关键词或切换平台。" : "可以先创建分组，再到管理账号添加账号。"}</p></div>}>
            {(account) => <ListBoxItem id={account.id} textValue={account.name} className="hotlist-group-member">
              {({ isSelected }) => <>
                <span className="hotlist-group-check" aria-hidden="true">{isSelected ? <Check size={12} strokeWidth={2.5} /> : null}</span>
                <span className="account-avatar tone-7" aria-hidden="true"><AccountAvatarImage account={account} size={30} /></span>
                <span className="hotlist-group-member-copy"><strong>{account.name}</strong><small>{getPlatformLabel(account.platform)} · {account.videoCount} 条视频</small></span>
                {isSelected ? <span className="hotlist-group-selected-label">已选择</span> : null}
              </>}
            </ListBoxItem>}
          </ListBox>
        </div>
        {accountIds.length ? <div className="hotlist-group-selected" aria-label="已选账号">
          {accounts.filter((account) => selected.has(account.id)).map((account) => <button key={account.id} className="btn ghost compact" type="button" aria-label={`取消选择 ${account.name}`} disabled={busy} onClick={() => setAccountIds(accountIds.filter((id) => id !== account.id))}><span>{account.name}</span><X size={12} aria-hidden="true" /></button>)}
        </div> : <p className="hotlist-group-selection-hint subtle">账号可稍后添加，分组名称保存后也可以修改。</p>}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
      <footer className="hotlist-group-editor-footer">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy ? "保存中…" : group ? "保存修改" : "创建分组"}</button>
      </footer>
    </form>
  </ModalBackdrop>;
}
