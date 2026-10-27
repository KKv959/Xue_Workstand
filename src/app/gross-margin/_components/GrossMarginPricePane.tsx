import { Calculator, RefreshCw, Save, Settings2 } from "lucide-react";
import { getActiveServiceOptions } from "@/lib/gross-margin-calculator";
import type { GrossMarginPriceOption } from "@/lib/types";
import type { GrossMarginWorkbenchController } from "../_hooks/useGrossMarginWorkbench";
import { PLATFORM_OPTIONS } from "../_lib/gross-margin-workbench-model";

type GrossMarginPricePaneProps = Pick<
  GrossMarginWorkbenchController,
  | "activePricePanelServiceConfigs"
  | "busy"
  | "handlePlatformChange"
  | "handleSavePriceTable"
  | "loading"
  | "openPriceEditor"
  | "platform"
  | "priceInputs"
  | "setPriceInput"
  | "table"
>;

export function GrossMarginPricePane({
  activePricePanelServiceConfigs,
  busy,
  handlePlatformChange,
  handleSavePriceTable,
  loading,
  openPriceEditor,
  platform,
  priceInputs,
  setPriceInput,
  table
}: GrossMarginPricePaneProps) {
  return (
    <aside className="pane gross-price-pane">
      <div className="pane-header">
        <div>
          <h2>平台单价表</h2>
          <p className="pane-subtitle">默认单价</p>
        </div>
        <button className="btn compact" disabled={!table || Boolean(busy)} onClick={openPriceEditor} type="button">
          <Settings2 aria-hidden="true" size={14} />
          整体编辑
        </button>
      </div>
      <div className="pane-body">
        <div className="source-tabs gross-platform-tabs" role="group" aria-label="选择平台">
          {PLATFORM_OPTIONS.map((option) => (
            <button
              aria-pressed={platform === option.value}
              className={platform === option.value ? "active" : ""}
              key={option.value}
              onClick={() => handlePlatformChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="empty-state-panel panel">
            <div className="panel-inner">
              <span className="empty-state-mark">
                <RefreshCw aria-hidden="true" size={17} />
              </span>
              <p className="subtle">正在读取本地毛利单价表。</p>
            </div>
          </div>
        ) : table ? (
          <>
            <div className="gross-price-groups">
              {activePricePanelServiceConfigs.map((config) => (
                <PriceGroup
                  config={config}
                  items={getActiveServiceOptions(table, config.service)}
                  key={config.service}
                  priceInputs={priceInputs}
                  onPriceChange={setPriceInput}
                />
              ))}
            </div>
            <button className="btn primary" disabled={busy === "prices"} onClick={() => void handleSavePriceTable()} type="button">
              <Save aria-hidden="true" size={15} />
              {busy === "prices" ? "保存中" : "保存单价表"}
            </button>
          </>
        ) : (
          <div className="empty-state-panel panel">
            <div className="panel-inner">
              <span className="empty-state-mark">
                <Calculator aria-hidden="true" size={17} />
              </span>
              <p className="subtle">单价表还没有初始化，请刷新后重试。</p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function PriceGroup({
  config,
  items,
  priceInputs,
  onPriceChange
}: {
  config: GrossMarginWorkbenchController["activePricePanelServiceConfigs"][number];
  items: GrossMarginPriceOption[];
  priceInputs: Record<string, string>;
  onPriceChange: (id: string, value: string) => void;
}) {
  if (items.length === 1) {
    const item = items[0];
    return (
      <section className="gross-price-group gross-price-group-compact">
        <label className="gross-price-option gross-price-option-single" key={item.id}>
          <h3>{config.label}</h3>
          <span className="gross-price-input">
            <PriceInput item={item} priceInputs={priceInputs} onPriceChange={onPriceChange} />
          </span>
        </label>
      </section>
    );
  }

  return (
    <section className="gross-price-group">
      <div>
        <h3>{config.label}</h3>
      </div>
      <div className="gross-price-option-list">
        {items.map((item) => (
          <label className="gross-price-option" key={item.id}>
            <span>{item.name}</span>
            <span className="gross-price-input">
              <PriceInput item={item} priceInputs={priceInputs} onPriceChange={onPriceChange} />
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function PriceInput({
  item,
  priceInputs,
  onPriceChange
}: {
  item: GrossMarginPriceOption;
  priceInputs: Record<string, string>;
  onPriceChange: (id: string, value: string) => void;
}) {
  return (
    <>
      <input
        autoComplete="off"
        inputMode="decimal"
        min={0}
        name={`${item.id}Price`}
        type="number"
        value={priceInputs[item.id] ?? String(item.unitPrice)}
        onChange={(event) => onPriceChange(item.id, event.target.value)}
        placeholder="例如 0.00…"
      />
      <small>{`元/${item.quantityUnit}`}</small>
    </>
  );
}
