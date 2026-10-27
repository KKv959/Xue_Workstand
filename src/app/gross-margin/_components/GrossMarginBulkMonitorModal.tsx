"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ClipboardPaste, X } from "lucide-react";
import { ModalBackdrop } from "@/components/ModalBackdrop";
import { parseGrossMarginBulkMonitorTemplate } from "@/lib/gross-margin-monitor-template";

export function GrossMarginBulkMonitorModal({
  busy,
  onClose,
  onSubmit
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { template: string; createProject: boolean; projectName: string }) => Promise<void>;
}) {
  const [template, setTemplate] = useState("");
  const parsed = useMemo(() => {
    try {
      return parseGrossMarginBulkMonitorTemplate(template);
    } catch (error) {
      return { items: [], warnings: [error instanceof Error ? error.message : "维护模板无法解析"] };
    }
  }, [template]);
  const defaultProjectName = useMemo(() => makeDefaultProjectName(parsed.items.length), [parsed.items.length]);
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [projectNameTouched, setProjectNameTouched] = useState(false);
  const [createProject, setCreateProject] = useState(true);
  const [createProjectTouched, setCreateProjectTouched] = useState(false);
  const canCreateProject = parsed.items.length > 1;
  const canSubmit = parsed.items.length > 0 && !busy;

  useEffect(() => {
    if (!projectNameTouched) setProjectName(defaultProjectName);
  }, [defaultProjectName, projectNameTouched]);

  useEffect(() => {
    if (!canCreateProject) {
      setCreateProject(false);
      setCreateProjectTouched(false);
      return;
    }
    if (!createProjectTouched) setCreateProject(true);
  }, [canCreateProject, createProjectTouched]);

  return (
    <ModalBackdrop
      disabled={busy}
      onClose={onClose}
      aria-labelledby="gross-bulk-monitor-modal-title"
      className="modal-panel gross-bulk-monitor-modal"
    >
        <header className="gross-bulk-monitor-header">
          <div>
            <h2 id="gross-bulk-monitor-modal-title">一键监控</h2>
            <p className="subtle">粘贴多条维护模板，自动识别视频链接和目标数据。</p>
          </div>
          <button aria-label="关闭一键监控弹窗" className="btn icon-btn icon-only" disabled={busy} onClick={onClose} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <div className="gross-bulk-monitor-layout">
          <label className="field gross-bulk-monitor-input">
            <span>模板内容</span>
            <textarea
              autoComplete="off"
              name="grossBulkMonitorTemplate"
              rows={14}
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              placeholder="粘贴多条账号昵称、视频链接、普通千川、HKJ 点赞、自定义评论、收藏、转发模板…"
            />
          </label>

          <aside className="gross-bulk-monitor-preview" aria-label="识别预览">
            <div className="gross-bulk-monitor-preview-head">
              <strong>{parsed.items.length} 条</strong>
              <span>{canCreateProject ? "可创建项目" : "单条监控"}</span>
            </div>

            {canCreateProject ? (
              <div className="gross-bulk-project-box">
                <label className={`gross-export-option${createProject ? " active" : ""}`}>
                  <input
                    checked={createProject}
                    disabled={busy}
                    name="grossBulkCreateProject"
                    onChange={(event) => {
                      setCreateProjectTouched(true);
                      setCreateProject(event.target.checked);
                    }}
                    type="checkbox"
                  />
                  <span>
                    <strong>添加成项目</strong>
                    <small>会出现在监控台的项目筛选里</small>
                  </span>
                </label>
                <input
                  aria-label="项目名"
                  autoComplete="off"
                  disabled={!createProject || busy}
                  name="grossBulkProjectName"
                  value={projectName}
                  onChange={(event) => {
                    setProjectNameTouched(true);
                    setProjectName(event.target.value);
                  }}
                  placeholder="填写项目名…"
                />
              </div>
            ) : null}

            <div className="gross-bulk-monitor-list">
              {parsed.items.length ? (
                parsed.items.map((item, index) => (
                  <div className="gross-bulk-monitor-item" key={`${index}-${item.accountName}-${item.videoUrl}`}>
                    <strong>{item.accountName}</strong>
                    <span>{formatTargets(item.targetStats, item.platform)}</span>
                  </div>
                ))
              ) : (
                <p>粘贴后会显示识别到的账号和目标。</p>
              )}
            </div>

            {[...parsed.warnings, ...parsed.items.flatMap((item) => item.warnings)].length ? (
              <div className="gross-bulk-monitor-warnings">
                {[...parsed.warnings, ...parsed.items.flatMap((item) => item.warnings)].map((warning, index) => (
                  <p key={`${index}-${warning}`}>{warning}</p>
                ))}
              </div>
            ) : null}
          </aside>
        </div>

        <footer className="button-row gross-bulk-monitor-actions">
          <button className="btn" disabled={busy} onClick={onClose} type="button">
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canSubmit}
            onClick={() => onSubmit({ template, createProject: canCreateProject && createProject, projectName })}
            type="button"
          >
            {canSubmit ? <Check aria-hidden="true" size={15} /> : <ClipboardPaste aria-hidden="true" size={15} />}
            {busy ? "添加中" : canCreateProject && createProject ? "添加为项目" : "添加监控"}
          </button>
        </footer>
    </ModalBackdrop>
  );
}

function makeDefaultProjectName(count: number) {
  if (count <= 1) return "";
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${month}${day} 批量监控 ${count} 条`;
}

function formatTargets(targetStats: Record<string, number>, platform: "bilibili" | "douyin") {
  const labels: Record<string, string> = {
    play: "播放",
    like: "点赞",
    coin: "投币",
    comment: "评论",
    favorite: "收藏",
    share: platform === "bilibili" ? "分享" : "转发",
    danmaku: "弹幕",
    mustFire: "必火",
    blueLink: "蓝链点击"
  };
  return (
    Object.entries(targetStats)
      .map(([service, value]) => `${labels[service] || service} ${formatMetric(value)}`)
      .join("，") || "未识别目标"
  );
}

function formatMetric(value: number) {
  if (value >= 10000) return `${Number((value / 10000).toFixed(2)).toLocaleString("zh-CN")}万`;
  return value.toLocaleString("zh-CN");
}
