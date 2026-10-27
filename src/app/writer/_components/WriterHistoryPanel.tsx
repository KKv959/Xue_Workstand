"use client";

import { memo, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, FileText, MoreHorizontal, Pencil, Search, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ModalBackdrop } from "@/components/ModalBackdrop";
import { formatDate, formatPlatform } from "@/components/Formatters";
import type { DraftSummary } from "@/lib/types";
import { WriterActionMenu } from "./WriterActionMenu";

type Props = {
  drafts: DraftSummary[];
  loading: boolean;
  selectedDraftId: string;
  initialSessionId?: string;
  onClose: () => void;
  onSelectDraft: (draft: DraftSummary) => Promise<boolean | void>;
  onRenameDraft: (draft: DraftSummary, title: string) => Promise<void>;
  onDeleteDraft: (draft: DraftSummary) => Promise<void>;
  onDeleteDrafts: (drafts: DraftSummary[]) => Promise<void>;
};

export const WriterHistoryPanel = memo(function WriterHistoryPanel({
  drafts, loading, selectedDraftId, initialSessionId = "", onClose, onSelectDraft, onRenameDraft, onDeleteDraft, onDeleteDrafts
}: Props) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const [manage, setManage] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<DraftSummary[]>([]);
  const [editing, setEditing] = useState<DraftSummary | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const sessions = useMemo(() => {
    const grouped = new Map<string, DraftSummary[]>();
    for (const draft of drafts) {
      const id = draft.version?.sessionId || draft.id;
      const group = grouped.get(id) || [];
      group.push(draft);
      grouped.set(id, group);
    }
    return [...grouped].map(([id, versions]) => {
      versions.sort((a, b) => (b.version?.revision || 1) - (a.version?.revision || 1) || +new Date(b.createdAt) - +new Date(a.createdAt));
      return { id, versions, latest: versions[0] };
    }).sort((a, b) => +new Date(b.latest.createdAt) - +new Date(a.latest.createdAt));
  }, [drafts]);
  const current = sessions.find((session) => session.id === sessionId);
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const visible = sessions.filter((session) => session.versions.some((draft) =>
    [draft.title, reference(draft), draft.version?.instruction].join(" ").toLocaleLowerCase("zh-CN").includes(normalized)));
  const rows = current ? current.versions : visible.slice(0, limit).map((session) => session.latest);
  // Overview selections include all versions of each selected manuscript.
  const selected = current ? current.versions.filter((draft) => selectedIds.includes(draft.id))
    : visible.filter((session) => selectedIds.includes(session.id)).flatMap((session) => session.versions);
  const locked = Boolean(busy);

  function changeView(id: string) {
    setSessionId(id); setManage(false); setSelectedIds([]); setEditing(null); setError("");
  }
  async function openDraft(draft: DraftSummary) {
    if (locked) return;
    setBusy(draft.id); setError("");
    try { if (await onSelectDraft(draft) !== false) onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取稿件失败，请重试。"); }
    finally { setBusy(""); }
  }
  async function rename() {
    if (!editing || !title.trim() || locked) return;
    setBusy("rename"); setError("");
    try { await onRenameDraft(editing, title.trim()); setEditing(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "重命名失败，请重试。"); }
    finally { setBusy(""); }
  }
  async function remove() {
    if (!deleting.length || locked) return;
    setBusy("delete"); setError("");
    try {
      if (deleting.length === 1) await onDeleteDraft(deleting[0]);
      else await onDeleteDrafts(deleting);
      setDeleting([]); setSelectedIds([]); setManage(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败，请重试。"); setDeleting([]); }
    finally { setBusy(""); }
  }

  return <>
    <ModalBackdrop
      onClose={onClose}
      disabled={locked || deleting.length > 0}
      initialFocusRef={searchRef}
      className="modal-panel writer-library"
      aria-labelledby="writer-library-title"
      aria-busy={locked || loading}
    >
        <header className="writer-library-heading">
          <div className="writer-library-heading-copy">
            {current ? <button className="btn ghost icon-only" aria-label="返回全部稿件" disabled={locked} onClick={() => changeView("")} type="button"><ArrowLeft size={18} /></button> : <FileText size={20} aria-hidden="true" />}
            <h2 id="writer-library-title">{current ? "稿件版本" : "稿件历史"}</h2>
            <span>{current ? current.versions.length : sessions.length}</span>
          </div>
          <div className="writer-library-heading-actions">
            <button className="btn ghost compact" type="button" disabled={locked || !drafts.length} onClick={() => { setManage(!manage); setSelectedIds([]); setEditing(null); }}>{manage ? "完成" : "选择"}</button>
            <button className="btn ghost icon-only" aria-label="关闭稿件历史" type="button" disabled={locked} onClick={onClose}><X size={18} /></button>
          </div>
        </header>
        {current ? <div className="writer-library-caption"><strong>{current.latest.title}</strong><span>{reference(current.latest)} · 点击版本继续编辑</span></div>
          : <label className="writer-library-search"><Search size={17} aria-hidden="true" /><input ref={searchRef} aria-label="搜索稿件" placeholder="搜索稿件、账号或项目" value={query} disabled={locked} onChange={(event) => { setQuery(event.target.value); setLimit(30); setSelectedIds([]); }} />{query ? <button className="btn ghost icon-only" type="button" aria-label="清空搜索" onClick={() => { setQuery(""); setLimit(30); searchRef.current?.focus(); }}><X size={14} /></button> : null}</label>}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="writer-library-list">
          {loading ? <p className="writer-library-empty" role="status">正在读取稿件…</p> : rows.length ? rows.map((draft) => {
            const session = sessions.find((item) => item.id === (draft.version?.sessionId || draft.id))!;
            const id = current ? draft.id : session.id;
            const active = current ? draft.id === selectedDraftId : session.versions.some((item) => item.id === selectedDraftId);
            return <article className={`writer-library-row${active ? " is-current" : ""}`} key={draft.id}>
              {manage ? <input type="checkbox" aria-label={`选择${draft.title}${current ? ` V${draft.version?.revision || 1}` : "（所有版本）"}`} checked={selectedIds.includes(id)} disabled={locked} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, id] : ids.filter((value) => value !== id))} /> : null}
              {editing?.id === draft.id ? <form className="writer-library-rename" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
                <input autoFocus aria-label="稿件名称" value={title} maxLength={40} disabled={locked} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); } }} />
                <button className="btn ghost icon-only" type="submit" aria-label="保存名称" disabled={locked || !title.trim()}><Check size={16} /></button>
                <button className="btn ghost icon-only" type="button" aria-label="取消重命名" disabled={locked} onClick={() => setEditing(null)}><X size={16} /></button>
              </form> : <button className="writer-library-open" type="button" disabled={locked} aria-current={active ? "true" : undefined} aria-pressed={manage ? selectedIds.includes(id) : undefined} onClick={() => manage ? setSelectedIds((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]) : void openDraft(draft)}>
                <span className="writer-library-row-title">{current ? `V${draft.version?.revision || 1} · ${draft.version?.origin === "manual_edit" ? "手动编辑" : draft.version?.instruction || "初稿"}` : draft.title}</span>
                <span className="writer-library-row-meta">{current ? formatDate(draft.createdAt) : `${reference(draft)} · ${formatDate(draft.createdAt)}`}{active ? " · 当前" : ""}</span>
              </button>}
              {!manage && !editing ? <div className="writer-library-row-actions">
                {busy === draft.id ? <small role="status">读取中…</small> : !current && session.versions.length > 1 ? <WriterActionMenu label={`选择“${draft.title}”的版本`} text={`${session.versions.length} 版`} icon={<ArrowUpRight size={12} aria-hidden="true" />} disabled={locked}>
                  {session.versions.map(version => <button type="button" key={version.id} onClick={() => void openDraft(version)}><span className="writer-version-option"><strong>V{version.version?.revision || 1}</strong><small>{version.version?.instruction || "初稿"}</small></span></button>)}
                </WriterActionMenu> : <ArrowUpRight size={15} aria-hidden="true" />}
                <WriterActionMenu label={`管理“${draft.title}”`} icon={<MoreHorizontal size={16} />}>
                  <button type="button" disabled={locked} onClick={() => { setEditing(draft); setTitle(draft.title); }}><Pencil size={15} />重命名{current ? "版本" : "稿件"}</button>
                  <button type="button" className="danger" disabled={locked} onClick={() => setDeleting(current ? [draft] : session.versions)}><Trash2 size={15} />{current ? "删除此版本" : "删除稿件及版本"}</button>
                </WriterActionMenu>
              </div> : null}
            </article>;
          }) : <div className="writer-library-empty"><FileText size={28} /><strong>{query ? "没有找到这篇稿件" : "还没有历史稿件"}</strong><p>{query ? "换个标题或风格名称试试" : "生成的稿件会自动保存在这里"}</p></div>}
          {!current && visible.length > limit ? <button className="btn ghost writer-library-load" type="button" onClick={() => setLimit((value) => value + 30)}>加载更多 · 还有 {visible.length - limit} 篇</button> : null}
        </div>
        {manage ? <footer className="writer-library-selection"><span>{current ? "选择要删除的版本" : "选择稿件会包含其所有版本"}</span><button className="btn danger compact" type="button" disabled={locked || !selected.length} onClick={() => setDeleting(selected)}>删除所选{selected.length ? `（${selected.length} 个版本）` : ""}</button></footer> : null}
    </ModalBackdrop>
    {deleting.length ? <ConfirmDialog title={current ? "删除版本" : "删除稿件"} body={`确认删除“${deleting[0].title}”${deleting.length > 1 ? `等 ${deleting.length} 个版本` : ""}？未选中的稿件和版本会保留。`} confirmLabel="删除" busy={busy === "delete"} onCancel={() => { if (!locked) setDeleting([]); }} onConfirm={() => void remove()} /> : null}
  </>;
});

function reference(draft: DraftSummary) {
  return draft.targetType === "project" ? draft.projectName || "项目" : `${draft.accountName || "账号"} · ${formatPlatform(draft.platform)}`;
}
