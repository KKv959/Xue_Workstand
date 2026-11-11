"use client";

import { memo, useId, useMemo, useRef, useState } from "react";
import { FileText, FolderClock, MoreHorizontal, Search, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ModalBackdrop } from "@/components/ModalBackdrop";
import { formatDate, formatPlatform } from "@/components/Formatters";
import { groupWriterHistoryProjects } from "@/lib/writer-history-batch";
import type { DraftSummary } from "@/lib/types";
import { WriterActionMenu } from "./WriterActionMenu";

type Props = {
  drafts: DraftSummary[];
  loading: boolean;
  selectedDraftId: string;
  embedded?: boolean;
  onClose: () => void;
  onSelectDraft: (draft: DraftSummary) => Promise<boolean | void>;
  onDeleteDraft: (draft: DraftSummary) => Promise<void>;
  onDeleteDrafts: (drafts: DraftSummary[]) => Promise<void>;
};

export const WriterHistoryPanel = memo(function WriterHistoryPanel({
  drafts, loading, selectedDraftId, embedded = false, onClose, onSelectDraft, onDeleteDraft, onDeleteDrafts
}: Props) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const [manage, setManage] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<DraftSummary[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const projects = useMemo(() => groupWriterHistoryProjects(drafts), [drafts]);
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const visible = projects.filter((project) => project.sessions.some((session) => session.versions.some((draft) =>
    [project.title, draft.title, reference(draft), draft.version?.instruction].join(" ").toLocaleLowerCase("zh-CN").includes(normalized))));
  const selected = visible.filter((project) => selectedIds.includes(project.id))
    .flatMap((project) => project.sessions.flatMap((session) => session.versions));
  const locked = Boolean(busy);

  async function openProject(draft: DraftSummary) {
    if (locked) return;
    setBusy(draft.id); setError("");
    try {
      if (await onSelectDraft(draft) !== false && !embedded) onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取项目失败，请重试。");
    } finally { setBusy(""); }
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

  const panel = <>
    <header className="writer-library-heading">
      <div className="writer-library-heading-copy">
        <FolderClock size={20} aria-hidden="true" />
        <h2 id={titleId}>历史项目</h2>
        <span>{projects.length}</span>
      </div>
      <div className="writer-library-heading-actions">
        <button className="btn ghost compact" type="button" disabled={locked || !drafts.length} onClick={() => { setManage(!manage); setSelectedIds([]); }}>{manage ? "完成" : "选择"}</button>
        {!embedded ? <button className="btn ghost icon-only" aria-label="关闭历史项目" type="button" disabled={locked} onClick={onClose}><X size={18} /></button> : null}
      </div>
    </header>
    <label className="writer-library-search"><Search size={17} aria-hidden="true" /><input ref={searchRef} aria-label="搜索历史项目" placeholder="搜索项目或账号" value={query} disabled={locked} onChange={(event) => { setQuery(event.target.value); setLimit(30); setSelectedIds([]); }} />{query ? <button className="btn ghost icon-only" type="button" aria-label="清空搜索" onClick={() => { setQuery(""); setLimit(30); searchRef.current?.focus(); }}><X size={14} /></button> : null}</label>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <div className="writer-library-list">
      {loading ? <p className="writer-library-empty" role="status">正在读取项目…</p> : visible.length ? visible.slice(0, limit).map((project) => {
        const active = project.sessions.some((session) => session.versions.some((item) => item.id === selectedDraftId));
        const projectDrafts = project.sessions.flatMap((session) => session.versions);
        return <article className={`writer-library-row${active ? " is-current" : ""}`} key={project.id}>
          {manage ? <input type="checkbox" aria-label={`选择项目${project.title}`} checked={selectedIds.includes(project.id)} disabled={locked} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, project.id] : ids.filter((value) => value !== project.id))} /> : null}
          <button className="writer-library-open" type="button" disabled={locked} aria-current={active ? "true" : undefined} aria-pressed={manage ? selectedIds.includes(project.id) : undefined} onClick={() => manage ? setSelectedIds((ids) => ids.includes(project.id) ? ids.filter((value) => value !== project.id) : [...ids, project.id]) : void openProject(project.latest)}>
            <span className="writer-library-row-title">{project.title}</span>
            <span className="writer-library-row-meta">{project.sessions.length} 篇 · {project.versionCount} 个版本 · {formatDate(project.latest.createdAt)}{active ? " · 当前" : ""}</span>
          </button>
          {!manage ? <div className="writer-library-row-actions">
            {busy === project.latest.id ? <small role="status">读取中…</small> : null}
            <WriterActionMenu label={`管理项目“${project.title}”`} icon={<MoreHorizontal size={16} />}>
              <button type="button" className="danger" disabled={locked} onClick={() => setDeleting(projectDrafts)}><Trash2 size={15} />删除整个项目</button>
            </WriterActionMenu>
          </div> : null}
        </article>;
      }) : <div className="writer-library-empty"><FileText size={28} /><strong>{query ? "没有找到这个项目" : "还没有历史项目"}</strong><p>{query ? "换个项目名或账号名试试" : "每次生成会自动保存为一个项目"}</p></div>}
      {visible.length > limit ? <button className="btn ghost writer-library-load" type="button" onClick={() => setLimit((value) => value + 30)}>加载更多 · 还有 {visible.length - limit} 个</button> : null}
    </div>
    {manage ? <footer className="writer-library-selection"><span>选择项目会包含其中全部稿件</span><button className="btn danger compact" type="button" disabled={locked || !selected.length} onClick={() => setDeleting(selected)}>删除所选{selected.length ? `（${selected.length} 个版本）` : ""}</button></footer> : null}
  </>;

  return <>
    {embedded ? <aside className="writer-library writer-history-sidebar" aria-labelledby={titleId} aria-busy={locked || loading}>{panel}</aside> : <ModalBackdrop
      onClose={onClose}
      disabled={locked || deleting.length > 0}
      initialFocusRef={searchRef}
      className="modal-panel writer-library"
      aria-labelledby={titleId}
      aria-busy={locked || loading}
    >{panel}</ModalBackdrop>}
    {deleting.length ? <ConfirmDialog title="删除项目" body={`确认删除“${deleting[0].title}”${deleting.length > 1 ? `等 ${deleting.length} 个版本` : ""}？其他项目会保留。`} confirmLabel="删除" busy={busy === "delete"} onCancel={() => { if (!locked) setDeleting([]); }} onConfirm={() => void remove()} /> : null}
  </>;
});

function reference(draft: DraftSummary) {
  return draft.targetType === "project" ? draft.projectName || "项目" : `${draft.accountName || "账号"} · ${formatPlatform(draft.platform)}`;
}
