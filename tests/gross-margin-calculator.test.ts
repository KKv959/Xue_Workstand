import assert from "node:assert/strict";
import test from "node:test";
import {
  GROSS_MARGIN_SERVICE_CONFIGS,
  calculateGrossMargin,
  getAbsoluteServiceQuantity,
  getMinimumQuantityWarning,
  getSplitRoundStep,
  makeDefaultSelections,
  makeEmptyQuantityInputs,
  roundUpToStep,
  toAbsoluteMetricValue
} from "../src/lib/gross-margin-calculator";
import type { GrossMarginCalculationLine, GrossMarginPriceOption, GrossMarginPriceTable } from "../src/lib/types";

const updatedAt = "2026-08-17T00:00:00.000Z";

test("毛利计算按选中档位和手工单价汇总成本与比例", () => {
  const table = makePriceTable([
    makeOption({ id: "play-normal", service: "play", name: "正常", unitPrice: 10, quantityUnit: "万" }),
    makeOption({ id: "play-fast", service: "play", name: "快速", unitPrice: 12, quantityUnit: "万" }),
    makeOption({ id: "like", service: "like", name: "点赞", unitPrice: 2.5, quantityUnit: "千" })
  ]);
  const configs = GROSS_MARGIN_SERVICE_CONFIGS.filter(({ service }) => service === "play" || service === "like");
  const quantityInputs = { ...makeEmptyQuantityInputs(), play: "2", like: "4" };

  const result = calculateGrossMargin({
    configs,
    discountPrice: 800,
    originalPrice: 1000,
    priceInputs: { "play-fast": "15", like: "2.5" },
    quantityInputs,
    selectedOptions: { play: "play-fast", like: "like" },
    table
  });

  assert.deepEqual(
    result.lines.map(({ service, optionId, quantity, unitPrice, total }) => ({ service, optionId, quantity, unitPrice, total })),
    [
      { service: "play", optionId: "play-fast", quantity: 2, unitPrice: 15, total: 30 },
      { service: "like", optionId: "like", quantity: 4, unitPrice: 2.5, total: 10 }
    ]
  );
  assert.equal(result.maintenanceCost, 40);
  assert.equal(result.grossProfit, 760);
  assert.equal(result.grossMarginRate, 0.76);
  assert.equal(result.rebateRate, 0.2);
});

test("毛利计算在价格为零或输入无效时返回稳定边界值", () => {
  const result = calculateGrossMargin({
    configs: GROSS_MARGIN_SERVICE_CONFIGS.filter(({ service }) => service === "play"),
    discountPrice: 200,
    originalPrice: 0,
    priceInputs: {},
    quantityInputs: { ...makeEmptyQuantityInputs(), play: "不是数字" },
    selectedOptions: {},
    table: null
  });

  assert.equal(result.maintenanceCost, 0);
  assert.equal(result.grossProfit, 200);
  assert.equal(result.grossMarginRate, 0);
  assert.equal(result.rebateRate, 0);
  assert.equal(result.lines[0]?.total, 0);
});

test("默认档位跳过停用项，没有可用档位时保持为空", () => {
  const table = makePriceTable([
    makeOption({ id: "play-disabled", service: "play", name: "停用", unitPrice: 8, quantityUnit: "万", active: false }),
    makeOption({ id: "play-active", service: "play", name: "可用", unitPrice: 10, quantityUnit: "万" }),
    makeOption({ id: "like-disabled", service: "like", name: "停用", unitPrice: 1, quantityUnit: "千", active: false })
  ]);

  const selections = makeDefaultSelections(table);
  assert.equal(selections.play, "play-active");
  assert.equal(selections.like, "");
});

test("B站必火按金额计入维护成本", () => {
  const table = makePriceTable([
    makeOption({ id: "bilibili-must-fire", service: "mustFire", name: "默认", unitPrice: 1, quantityUnit: "元" })
  ]);
  table.platform = "bilibili";
  const quantityInputs = { ...makeEmptyQuantityInputs(), mustFire: "120" };
  const result = calculateGrossMargin({
    configs: GROSS_MARGIN_SERVICE_CONFIGS.filter(({ service }) => service === "mustFire"),
    discountPrice: 500,
    originalPrice: 600,
    priceInputs: { "bilibili-must-fire": "1" },
    quantityInputs,
    selectedOptions: { mustFire: "bilibili-must-fire" },
    table
  });

  assert.equal(result.lines[0]?.label, "必火");
  assert.equal(result.lines[0]?.total, 120);
  assert.equal(result.maintenanceCost, 120);
  assert.equal(result.grossProfit, 380);
});

test("必火排在维护项最底部", () => {
  assert.equal(GROSS_MARGIN_SERVICE_CONFIGS.at(-1)?.service, "mustFire");
});

test("起量提示只在已输入且未达门槛时出现", () => {
  const option = makeOption({
    id: "play",
    service: "play",
    name: "播放",
    unitPrice: 10,
    quantityUnit: "万",
    minimumQuantity: 0.5
  });

  assert.equal(getMinimumQuantityWarning(option, "0.25", 0.25), "未达起量，至少 0.5万");
  assert.equal(getMinimumQuantityWarning(option, "", 0), "");
  assert.equal(getMinimumQuantityWarning(option, "0.5", 0.5), "");
});

test("数量换算与拆单向上取整遵守各服务粒度", () => {
  const playLine = makeCalculationLine({ service: "play", quantity: 1.25, quantityUnit: "万" });
  const commentLine = makeCalculationLine({ service: "comment", quantity: 1.6, quantityUnit: "千" });

  assert.equal(toAbsoluteMetricValue(playLine), 12_500);
  assert.equal(getAbsoluteServiceQuantity([commentLine], "comment"), 1_600);
  assert.equal(roundUpToStep(12_001, getSplitRoundStep("play")), 20_000);
  assert.equal(roundUpToStep(1_201, getSplitRoundStep("like")), 2_000);
  assert.equal(roundUpToStep(101, getSplitRoundStep("comment")), 110);
  assert.equal(roundUpToStep(Number.NaN, 10), 0);
});

function makePriceTable(items: GrossMarginPriceOption[]): GrossMarginPriceTable {
  return { platform: "douyin", items, updatedAt };
}

function makeOption(
  input: Omit<GrossMarginPriceOption, "updatedAt">
): GrossMarginPriceOption {
  return { ...input, updatedAt };
}

function makeCalculationLine(
  input: Pick<GrossMarginCalculationLine, "service" | "quantity" | "quantityUnit">
): GrossMarginCalculationLine {
  return {
    label: input.service,
    optionId: input.service,
    optionName: input.service,
    unitPrice: 0,
    total: 0,
    ...input
  };
}
