"use client";

import { normalizeGrossMarginAccountName } from "@/lib/gross-margin-account-names";
import { WorkbenchSelect, WorkbenchSelectPopover } from "@/components/WorkbenchSelect";

import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { Button, ComboBox, Input, ListBox, ListBoxItem } from "react-aria-components";
import {
  getActiveServiceOptions,
  getMinimumQuantityWarning,
  getSelectedOption
} from "@/lib/gross-margin-calculator";
import type { GrossMarginAccountPrice } from "@/lib/types";
import type { GrossMarginWorkbenchController } from "../_hooks/useGrossMarginWorkbench";
import {
  describeQuantityInput,
  formatMoney,
  formatPlatform,
  formatTypeOptionName,
  getGrossMarginAccountPrice,
  formatUnitPrice
} from "../_lib/gross-margin-workbench-model";

type GrossMarginMaintenancePaneProps = Pick<
  GrossMarginWorkbenchController,
  | "accountName"
  | "accountPriceKind"
  | "activeServiceConfigs"
  | "calculation"
  | "discountPrice"
  | "handleAccountNameChange"
  | "handleAccountPriceKindChange"
  | "handleRebateRateChange"
  | "handleVideoUrlChange"
  | "matchedAccount"
  | "originalPrice"
  | "platform"
  | "platformAccounts"
  | "quantityInputs"
  | "rebateRate"
  | "selectedOptions"
  | "setDiscountPrice"
  | "setQuantityInput"
  | "setSelectedOption"
  | "table"
  | "updateOriginalPrice"
  | "videoUrl"
  | "videoAccountLookup"
  | "projectOrders"
  | "selectedProject"
  | "projectSelectionValue"
  | "projectMonth"
  | "projectSourceError"
  | "projectSourceLoading"
  | "refreshProjects"
  | "handleProjectChange"
>;

type GrossMarginAccountComboboxProps = {
  accounts: GrossMarginAccountPrice[];
  busy: boolean;
  onChange: (value: string) => void;
  value: string;
};

function GrossMarginAccountCombobox({ accounts, busy, onChange, value }: GrossMarginAccountComboboxProps) {
  return (
    <ComboBox aria-label="账号名" className="gross-account-combobox" allowsCustomValue menuTrigger="focus"
      defaultItems={accounts} defaultFilter={(name, query) => normalizeGrossMarginAccountName(name).includes(normalizeGrossMarginAccountName(query))}
      inputValue={value} onInputChange={onChange}>
      <div className="gross-account-input-row">
        <Input aria-busy={busy} autoComplete="off" id="gross-account-name" name="accountName" placeholder="输入账号名自动带价格…" />
        <Button aria-label="展开账号列表" className="gross-account-toggle"><ChevronDown aria-hidden="true" size={16} /></Button>
      </div>
      <WorkbenchSelectPopover placement="bottom start" offset={6}>
        <ListBox<GrossMarginAccountPrice> aria-label="账号列表" className="workbench-select-options">
          {account => <ListBoxItem id={account.name} textValue={account.name} className="workbench-select-option">
            {({ isSelected }) => <><span>{account.name}</span>{isSelected ? <Check aria-hidden="true" size={15} /> : null}</>}
          </ListBoxItem>}
        </ListBox>
      </WorkbenchSelectPopover>
    </ComboBox>
  );
}

export function GrossMarginMaintenancePane({
  accountName,
  accountPriceKind,
  activeServiceConfigs,
  calculation,
  discountPrice,
  handleAccountNameChange,
  handleAccountPriceKindChange,
  handleRebateRateChange,
  handleVideoUrlChange,
  matchedAccount,
  originalPrice,
  platform,
  platformAccounts,
  quantityInputs,
  rebateRate,
  selectedOptions,
  setDiscountPrice,
  setQuantityInput,
  setSelectedOption,
  table,
  updateOriginalPrice,
  videoUrl,
  videoAccountLookup,
  projectOrders,
  selectedProject,
  projectSelectionValue,
  projectMonth,
  projectSourceError,
  projectSourceLoading,
  refreshProjects,
  handleProjectChange
}: GrossMarginMaintenancePaneProps) {
  const selectedAccountPrice = matchedAccount
    ? getGrossMarginAccountPrice(matchedAccount, accountPriceKind)
    : null;
  const accountPriceOptions = [
    { kind: "custom" as const, label: "定制" },
    { kind: "implant" as const, label: "植入" }
  ];

  return (
    <section className="pane gross-maintenance-pane">
      <div className="pane-header">
        <div>
          <h2>{formatPlatform(platform)}本次维护</h2>
          <p className="pane-subtitle">价格与数量</p>
        </div>
      </div>
      <div className="pane-body">
        <div className="detail-section gross-price-summary-form">
          <div className="gross-account-row">
            <div className="field">
              <label htmlFor="gross-account-name">账号名</label>
              <GrossMarginAccountCombobox
                accounts={platformAccounts}
                busy={videoAccountLookup.status === "loading"}
                onChange={handleAccountNameChange}
                value={accountName}
              />
              <span className={`field-hint${!selectedProject && !matchedAccount && accountName.trim() ? " warning" : ""}`}>
                {selectedProject ? "已带入项目报价" : matchedAccount ? `已匹配${selectedAccountPrice?.label}：${formatMoney(selectedAccountPrice?.value || 0)}` : accountName.trim() ? "未匹配账号，价格可手填" : "\u00a0"}
              </span>
            </div>
            <div className="field gross-project-field" title={selectedProject ? `${selectedProject.projectName}${selectedProject.date ? ` · ${selectedProject.date}` : ""}` : undefined}>
              <label htmlFor="gross-project">项目</label>
              <div className="gross-project-controls">
                <WorkbenchSelect aria-label="项目" aria-describedby="gross-project-hint" id="gross-project" value={projectSelectionValue} onValueChange={handleProjectChange}>
                  <option value="choose" disabled>{projectSourceLoading ? "正在同步当月项目…" : !accountName.trim() ? "请先选择账号" : projectOrders.length ? "请选择当月项目" : projectSourceError ? "同步失败，可手动填写" : "暂无匹配的当月项目"}</option>
                  {projectOrders.map(order => <option value={order.id} key={order.id}>{order.projectName}{order.date ? ` · ${order.date}` : ""}{order.orderAmount !== null ? ` · ${formatMoney(order.orderAmount)}` : ""}</option>)}
                  <option value="manual">手动填写</option>
                </WorkbenchSelect>
                <button className="btn compact icon-only" type="button" aria-label={projectSourceLoading ? "同步项目中" : projectSourceError ? "重试同步项目" : "同步项目"} title={projectSourceLoading ? "同步项目中" : projectSourceError ? "重试同步项目" : "同步项目"} disabled={projectSourceLoading} onClick={() => void refreshProjects()}><RefreshCw size={16} aria-hidden="true" /></button>
              </div>
              <span id="gross-project-hint" className={`field-hint${projectSourceError || selectedProject?.warning ? " warning" : ""}`} role="status" title={projectSourceError || selectedProject?.warning}>
                {projectSourceLoading ? "正在同步项目报价，已有缓存仍可使用" : projectSourceError || selectedProject?.warning || (selectedProject ? `返点金额：${formatMoney(selectedProject.rebateAmount || 0)}` : `${projectMonth || "当月"} · ${projectOrders.length} 个项目 · 右侧按钮手动同步`)}
              </span>
            </div>
            <div className="field">
              <label htmlFor="gross-video-url">视频链接</label>
              <input
                autoComplete="off"
                id="gross-video-url"
                name="videoUrl"
                type="url"
                value={videoUrl}
                title={videoUrl || undefined}
                onBlur={() => handleVideoUrlChange(videoUrl)}
                onChange={(event) => handleVideoUrlChange(event.target.value)}
                placeholder="粘贴视频链接，导出时会带上…"
              />
              <span
                aria-live="polite"
                className={`field-hint${videoAccountLookup.status === "error" || videoAccountLookup.status === "unmatched" ? " warning" : ""}`}
                title={videoAccountLookup.message}
              >
                {videoAccountLookup.message || "\u00a0"}
              </span>
            </div>
          </div>
          <div className="gross-price-summary-grid">
            <div className="field">
              <label htmlFor="gross-original-price">折前价格</label>
              <div className="gross-original-price-control">
                <span aria-label="折前价格类型" className="gross-account-price-kinds" role="group">
                  {accountPriceOptions.map((option) => (
                    <button
                      aria-pressed={accountPriceKind === option.kind}
                      className={accountPriceKind === option.kind ? "active" : ""}
                      disabled={option.kind === "implant" && matchedAccount?.secondaryPrice === undefined}
                      key={option.kind}
                      onClick={() => handleAccountPriceKindChange(option.kind)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </span>
                <input
                  autoComplete="off"
                  id="gross-original-price"
                  inputMode="decimal"
                  min={0}
                  name="originalPrice"
                  type="number"
                  value={originalPrice}
                  onChange={(event) => updateOriginalPrice(event.target.value)}
                  placeholder="原档位价格…"
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="gross-rebate-rate">返点</label>
              <span className="gross-rate-input">
                <input
                  autoComplete="off"
                  id="gross-rebate-rate"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  name="rebateRate"
                  type="number"
                  value={rebateRate}
                  onChange={(event) => handleRebateRateChange(event.target.value)}
                  placeholder="可不填…"
                />
                <small>%</small>
              </span>
            </div>
            <div className="field">
              <label htmlFor="gross-discount-price">折后价格</label>
              <input
                autoComplete="off"
                id="gross-discount-price"
                inputMode="decimal"
                min={0}
                name="discountPrice"
                type="number"
                value={discountPrice}
                onChange={(event) => setDiscountPrice(event.target.value)}
                placeholder="实际报价…"
              />
            </div>
          </div>
        </div>

        <div className="gross-maintenance-table-wrap">
          <table className="gross-maintenance-table">
            <thead>
              <tr>
                <th>维护项</th>
                <th>类型</th>
                <th>数量</th>
                <th>单价</th>
                <th>小计</th>
              </tr>
            </thead>
            <tbody>
              {activeServiceConfigs.map((config) => {
                const options = table ? getActiveServiceOptions(table, config.service) : [];
                const selectedOption = getSelectedOption(options, selectedOptions[config.service]);
                const line = calculation.lines.find(line => line.service === config.service);
                const minimumWarning = getMinimumQuantityWarning(
                  selectedOption,
                  quantityInputs[config.service],
                  line?.quantity ?? 0
                );
                return (
                  <tr key={config.service}>
                    <td>
                      <strong>{config.label}</strong>
                      <span>{describeQuantityInput(selectedOption?.quantityUnit)}</span>
                    </td>
                    <td>
                      <WorkbenchSelect
                        aria-label={`${config.label}类型`}
                        name={`${config.service}Option`}
                        value={selectedOption?.id || ""}
                        onValueChange={(value) => setSelectedOption(config.service, value)}
                      >
                        {options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {formatTypeOptionName(option.name)}
                          </option>
                        ))}
                      </WorkbenchSelect>
                    </td>
                    <td>
                      <div className="gross-quantity-cell">
                        <span className={`gross-quantity-input${minimumWarning ? " gross-input-warning" : ""}`}>
                          <input
                            aria-label={`${config.label}数量`}
                            autoComplete="off"
                            inputMode="decimal"
                            min={0}
                            name={`${config.service}Quantity`}
                            type="number"
                            value={quantityInputs[config.service]}
                            onChange={(event) => setQuantityInput(config.service, event.target.value)}
                          />
                          <small>{selectedOption?.quantityUnit || "个"}</small>
                        </span>
                        {minimumWarning ? <small className="gross-quantity-warning">{minimumWarning}</small> : null}
                      </div>
                    </td>
                    <td>{formatUnitPrice(line?.unitPrice ?? 0)}</td>
                    <td>{formatMoney(line?.total ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
