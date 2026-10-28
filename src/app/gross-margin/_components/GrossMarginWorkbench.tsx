"use client";

import type { AppMode } from "@/lib/app-mode";
import { GrossMarginBulkMonitorModal } from "./GrossMarginBulkMonitorModal";
import { GrossMarginImportModal } from "./GrossMarginImportModal";
import { GrossMarginMaintenancePane } from "./GrossMarginMaintenancePane";
import { GrossMarginPricePane } from "./GrossMarginPricePane";
import { GrossMarginPriceTableEditorModal } from "./GrossMarginPriceTableEditorModal";
import { GrossMarginResultPane } from "./GrossMarginResultPane";
import { GrossMarginTemplateModal } from "./GrossMarginTemplateModal";
import { useGrossMarginWorkbench } from "../_hooks/useGrossMarginWorkbench";
import { formatPlatform } from "../_lib/gross-margin-workbench-model";

export function GrossMarginWorkbench({ appMode }: { appMode: AppMode }) {
  const controller = useGrossMarginWorkbench();

  return (
    <div className="page gross-margin-page gross-margin-workbench-page">
      <section className="panel three-pane gross-margin-workspace" aria-label="数据维护工作区">
        <GrossMarginPricePane {...controller} />
        <GrossMarginMaintenancePane {...controller} />
        <GrossMarginResultPane {...controller} appMode={appMode} />
      </section>

      {controller.importModalOpen ? (
        <GrossMarginImportModal
          initialPlatform={controller.platform}
          onClose={controller.closeImportModal}
          onImport={controller.handleImportTemplate}
        />
      ) : null}
      {controller.templateModalOpen ? (
        <GrossMarginTemplateModal
          busy={controller.busy === "template"}
          platformLabel={formatPlatform(controller.platform)}
          previewValues={controller.reviewTemplateValues}
          template={controller.reviewTemplate}
          onClose={controller.closeTemplateModal}
          onSave={controller.handleSaveReviewTemplate}
        />
      ) : null}
      {controller.priceEditorOpen && controller.table ? (
        <GrossMarginPriceTableEditorModal
          busy={controller.busy === "price-editor"}
          platformLabel={formatPlatform(controller.table.platform)}
          table={controller.table}
          onClose={controller.closePriceEditor}
          onSave={controller.handleSaveFullPriceTable}
        />
      ) : null}
      {controller.bulkMonitorModalOpen ? (
        <GrossMarginBulkMonitorModal
          busy={controller.busy === "bulk-monitor"}
          onClose={controller.closeBulkMonitorModal}
          onSubmit={controller.handleBulkMonitorSubmit}
        />
      ) : null}
    </div>
  );
}
