"use client";

import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import type { DouyinHotlistGroup } from "@/lib/types";

export function HotlistGroupFilter({ groups, selectedId, accountCount, disabled, onSelect, onAdd, onEdit, onDelete }: {
  groups: DouyinHotlistGroup[]; selectedId: string; accountCount: number; disabled: boolean;
  onSelect: (id: string) => void; onAdd: () => void; onEdit: () => void; onDelete: () => void;
}) {
  return <div className="hotlist-group-bar">
    <div className="hotlist-group-filters" role="group" aria-label="监控分组筛选">
      <button type="button" className={`btn compact ${selectedId === "all" ? "active" : "ghost"}`} aria-pressed={selectedId === "all"} disabled={disabled} onClick={() => onSelect("all")}>全部<span>{accountCount}</span></button>
      {groups.map((group) => <button type="button" key={group.id} title={group.name} className={`btn compact ${selectedId === group.id ? "active" : "ghost"}`} aria-pressed={selectedId === group.id} disabled={disabled} onClick={() => onSelect(group.id)}><span className="hotlist-group-filter-name">{group.name}</span><span>{group.accountIds.length}</span></button>)}
    </div>
    <div className="hotlist-group-actions">
      {groups.some((group) => group.id === selectedId) ? <button type="button" className="btn ghost compact" disabled={disabled} onClick={onEdit}><Pencil size={14} aria-hidden="true" />编辑分组</button> : null}
      {groups.some((group) => group.id === selectedId) ? <button type="button" className="btn ghost compact" disabled={disabled} onClick={onDelete}><Trash2 size={14} aria-hidden="true" />删除分组</button> : null}
      <button type="button" className="btn ghost compact" disabled={disabled} onClick={onAdd}><FolderPlus size={15} aria-hidden="true" />添加分组</button>
    </div>
  </div>;
}
