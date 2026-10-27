import Link from "next/link";
import type { AppMode } from "@/lib/app-mode";
import { Copy, FileText, MessageSquarePlus, Upload } from "lucide-react";
import type { GrossMarginWorkbenchController } from "../_hooks/useGrossMarginWorkbench";
import {
  formatEngagementTargetCounts,
  formatMoney,
  formatPercent,
  getGrossTone
} from "../_lib/gross-margin-workbench-model";

type GrossMarginResultPaneProps = Pick<
  GrossMarginWorkbenchController,
  | "busy"
  | "platform"
  | "calculation"
  | "engagementTarget"
  | "handleExportReview"
  | "openBulkMonitorModal"
  | "openImportModal"
  | "openTemplateModal"
  | "reviewTemplate"
  | "reviewTemplateLineCount"
  | "setSplitDeliveryEnabled"
  | "splitDeliveryEnabled"
  | "validationError"
> & { appMode: AppMode };

export function GrossMarginResultPane({
  busy,
  calculation,
  platform,
  engagementTarget,
  handleExportReview,
  openBulkMonitorModal,
  openImportModal,
  openTemplateModal,
  reviewTemplate,
  reviewTemplateLineCount,
  setSplitDeliveryEnabled,
  splitDeliveryEnabled,
  appMode,
  validationError
}: GrossMarginResultPaneProps) {
  return (
    <aside className="pane gross-result-pane">
      <div className="pane-header">
        <div>
          <h2>结果</h2>
          <p className="pane-subtitle">实时汇总与导出</p>
        </div>
      </div>
      <div className="pane-body">
        {validationError ? <p className="notice error" role="alert">{validationError}</p> : null}
        <div className="gross-result-panel maintenance">
          <span>维护成本</span>
          <strong>{formatMoney(calculation.maintenanceCost)}</strong>
          <small>{calculation.lines.filter((line) => line.quantity > 0).length} 个项目已录入数量</small>
        </div>

        <div className={`gross-result-panel ${getGrossTone(calculation.grossMarginRate)}`}>
          <span>毛利率</span>
          <strong>{formatPercent(calculation.grossMarginRate)}</strong>
          <small>{formatMoney(calculation.grossProfit)} 毛利额</small>
        </div>

        <div className="gross-result-grid">
          <MetricItem label="折前价格" value={formatMoney(calculation.originalPrice)} />
          <MetricItem label="折后价格" value={formatMoney(calculation.discountPrice)} />
          <MetricItem label="返点" value={formatPercent(calculation.rebateRate)} />
          <MetricItem
            label="维护成本占折前"
            value={formatPercent(calculation.originalPrice ? calculation.maintenanceCost / calculation.originalPrice : 0)}
          />
        </div>

        <div className="gross-result-tools">
          <button className="gross-template-entry" onClick={openTemplateModal} type="button">
            <span className="gross-template-entry-copy">
              <FileText aria-hidden="true" size={16} />
              <span>
                <strong>文案模板</strong>
                <small>{reviewTemplateLineCount} 行，{reviewTemplate.customized ? "永久自定义" : "系统默认"}</small>
              </span>
            </span>
            <strong className="gross-template-entry-action">编辑</strong>
          </button>

          <label className={`gross-export-option${splitDeliveryEnabled ? " active" : ""}`}>
            <input
              checked={splitDeliveryEnabled}
              name="splitDeliveryEnabled"
              onChange={(event) => setSplitDeliveryEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>分两轮投放</strong>
              <small>首轮 60%，次轮 40%，导出时自动补首轮目标</small>
            </span>
          </label>
        </div>

        <div className="gross-action-panel">
          <div className="gross-action-grid">
            <button className="btn" onClick={openImportModal} type="button">
              <Upload aria-hidden="true" size={15} />
              导入模板
            </button>
            <button className="btn" disabled={Boolean(busy)} onClick={openBulkMonitorModal} type="button">
              <Upload aria-hidden="true" size={15} />
              一键监控
            </button>
            <button
              aria-busy={busy === "export"}
              className="btn primary gross-export-primary"
              disabled={Boolean(busy) || Boolean(validationError)}
              onClick={() => void handleExportReview()}
              type="button"
            >
              <Copy aria-hidden="true" size={15} />
              {busy === "export" ? "导出中" : platform === "douyin" ? "导出文案" : "导出并监控"}
            </button>
          </div>
          {appMode === "workspace" ? <EngagementJump engagementTarget={engagementTarget} /> : null}
        </div>
      </div>
    </aside>
  );
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="metric-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function EngagementJump({
  engagementTarget
}: {
  engagementTarget: GrossMarginWorkbenchController["engagementTarget"];
}) {
  const content = (
    <>
      <span className="gross-engagement-jump-copy">
        <MessageSquarePlus aria-hidden="true" size={15} />
        <span>
          <strong>评论 / 弹幕</strong>
          <small>{formatEngagementTargetCounts(engagementTarget)}</small>
        </span>
      </span>
      <strong className="gross-engagement-jump-action">去生成</strong>
    </>
  );

  if (engagementTarget.href) {
    return <Link className="gross-engagement-jump" href={engagementTarget.href}>{content}</Link>;
  }
  return <button className="gross-engagement-jump" disabled type="button">{content}</button>;
}
