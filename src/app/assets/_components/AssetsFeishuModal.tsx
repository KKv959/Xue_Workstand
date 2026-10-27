"use client";

import { ExternalLink } from "lucide-react";
import { ModalBackdrop } from "@/components/ModalBackdrop";

type AssetsFeishuModalProps = {
  result: {
    title: string;
    url: string;
  };
  onClose: () => void;
};

export function AssetsFeishuModal({ result, onClose }: AssetsFeishuModalProps) {
  return (
    <ModalBackdrop
      onClose={onClose}
      aria-labelledby="assets-feishu-dialog-title"
      className="modal-panel feishu-modal"
    >
        <div className="modal-header">
          <h2 id="assets-feishu-dialog-title">飞书文档已创建</h2>
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
    </ModalBackdrop>
  );
}
