"use client";

import { ExternalLink } from "lucide-react";
import { WriterDialogModal } from "./WriterDialogModal";

type FeishuResultModalProps = {
  result: {
    title: string;
    url: string;
  };
  onClose: () => void;
};

export function FeishuResultModal({ result, onClose }: FeishuResultModalProps) {
  return (
    <WriterDialogModal labelledBy="writer-feishu-dialog-title" panelClassName="feishu-modal" onClose={onClose}>
      <div className="modal-header">
        <h2 id="writer-feishu-dialog-title">飞书文档已创建</h2>
        <button className="btn" onClick={onClose} type="button">
          关闭
        </button>
      </div>
      <div className="feishu-success-card">
        <p>{result.title}</p>
        <a className="btn primary" href={result.url} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" size={16} />
          打开飞书文档
        </a>
      </div>
    </WriterDialogModal>
  );
}
