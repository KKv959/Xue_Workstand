import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEngagementTarget,
  buildGrossMarginTemplateValues,
  buildImportedMaintenanceState,
  findGrossMarginAccount,
  getGrossMarginAccountPrice,
  normalizeTemplateText
} from "../src/app/gross-margin/_lib/gross-margin-workbench-model";
import type {
  GrossMarginAccountPrice,
  GrossMarginCalculationLine,
  GrossMarginCalculationResult,
  GrossMarginPriceOption,
  GrossMarginPriceTable
} from "../src/lib/types";

const updatedAt = "2026-08-17T00:00:00.000Z";

test("导入维护模板会匹配档位、换算数量并带出账号价格", () => {
  const table = makePriceTable([
    makeOption({ id: "play-normal", service: "play", name: "播放（正常）", unitPrice: 10, quantityUnit: "万" }),
    makeOption({ id: "play-fast", service: "play", name: "播放（快速）", unitPrice: 15, quantityUnit: "万" }),
    makeOption({ id: "like", service: "like", name: "点赞", unitPrice: 2, quantityUnit: "千" })
  ]);
  const accounts: GrossMarginAccountPrice[] = [
    { platform: "douyin", name: " 测试 账号 ", defaultPrice: 1_000, priceLabel: "刊例价" }
  ];

  const result = buildImportedMaintenanceState({
    accountName: "旧账号",
    accounts,
    currentPlatform: "bilibili",
    currentPriceInputs: {},
    currentTable: null,
    currentVideoUrl: "",
    tables: [table],
    template: {
      platform: "douyin",
      accountName: "测试账号",
      videoUrl: "https://www.douyin.com/video/123",
      metrics: [
        { service: "play", label: "播放量", optionHint: "快速", rawValue: "2.5万" },
        { service: "like", label: "点赞", optionHint: "", rawValue: "3,000" }
      ]
    }
  });

  assert.equal(result.platform, "douyin");
  assert.equal(result.selectedOptions.play, "play-fast");
  assert.equal(result.quantityInputs.play, "2.5");
  assert.equal(result.quantityInputs.like, "3");
  assert.equal(result.priceInputs["play-fast"], "15");
  assert.equal(result.matchedAccount?.defaultPrice, 1_000);
});

test("审核模板值会保留账号标识并按服务粒度生成首轮目标", () => {
  const calculation = makeCalculation([
    makeLine({ service: "play", optionId: "play-normal", optionName: "播放（正常）", quantity: 1.2, quantityUnit: "万" }),
    makeLine({ service: "like", quantity: 12, quantityUnit: "千" }),
    makeLine({ service: "douPlus", quantity: 101, quantityUnit: "元" })
  ]);
  const account: GrossMarginAccountPrice = {
    platform: "douyin",
    name: "测试账号",
    defaultPrice: 1_000,
    priceLabel: "刊例价",
    douyinId: "douyin-1",
    cooperationCode: "code-1"
  };

  const values = buildGrossMarginTemplateValues({
    account,
    accountName: "",
    calculation,
    platform: "douyin",
    splitDeliveryEnabled: true,
    videoTitle: " 视频标题 ",
    currentPlayCount: 12345,
    videoUrl: " https://www.douyin.com/video/123 "
  });

  assert.equal(values.accountName, "测试账号");
  assert.equal(values.douyinId, "douyin-1");
  assert.equal(values.playLabel, "（播放）");
  assert.equal(values.playValue, "1.2万");
  assert.equal(values.grossProfit, "700");
  assert.equal(values.splitRoundLine, "分两轮维护：第一轮，播放1万，点赞8000，抖加61元");
  assert.equal(values.videoUrl, "https://www.douyin.com/video/123");
  assert.equal(values.videoTitle, "视频标题");
  assert.equal(values.currentPlayValue, "12345");
});

test("当前播放量保留真实零值，缺失或非法数据显式显示未获取", () => {
  for (const currentPlayCount of [0, null, undefined, NaN, -1]) {
    const values = buildGrossMarginTemplateValues({
      account: null, accountName: "", calculation: makeCalculation([]), platform: "bilibili",
      splitDeliveryEnabled: false, videoUrl: "", currentPlayCount
    });
    assert.equal(values.currentPlayValue, currentPlayCount === 0 ? "0" : "未获取");
  }
});

test("评论弹幕目标只在有数量时生成跳转参数", () => {
  const target = buildEngagementTarget([
    makeLine({ service: "comment", quantity: 1.6, quantityUnit: "千" }),
    makeLine({ service: "danmaku", quantity: 25, quantityUnit: "个" })
  ], "https://www.bilibili.com/video/BV1test");

  assert.equal(target.commentCount, 1_600);
  assert.equal(target.danmakuCount, 25);
  assert.equal(
    target.href,
    "/assets?source=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1test&comments=1600&danmaku=25"
  );
  assert.equal(buildEngagementTarget([], "").href, "");
});

test("账号匹配和模板换行归一化保持稳定", () => {
  const accounts: GrossMarginAccountPrice[] = [
    { platform: "bilibili", name: "测试 UP主", defaultPrice: 800, priceLabel: "报价" }
  ];

  assert.equal(findGrossMarginAccount(accounts, "测试up主")?.defaultPrice, 800);
  assert.equal(normalizeTemplateText(" 第一行\r\n第二行\r\n"), "第一行\n第二行");
});

test("账号报价可在定制和植入间切换", () => {
  const account: GrossMarginAccountPrice = {
    platform: "douyin",
    name: "双报价账号",
    defaultPrice: 10_500,
    priceLabel: "定制报价",
    secondaryPrice: 8_680,
    secondaryPriceLabel: "植入报价"
  };

  assert.deepEqual(getGrossMarginAccountPrice(account, "custom"), {
    kind: "custom",
    label: "定制报价",
    value: 10_500
  });
  assert.deepEqual(getGrossMarginAccountPrice(account, "implant"), {
    kind: "implant",
    label: "植入报价",
    value: 8_680
  });
});

function makePriceTable(items: GrossMarginPriceOption[]): GrossMarginPriceTable {
  return { platform: "douyin", items, updatedAt };
}

function makeOption(input: Omit<GrossMarginPriceOption, "updatedAt">): GrossMarginPriceOption {
  return { ...input, updatedAt };
}

function makeLine(
  input: Pick<GrossMarginCalculationLine, "service" | "quantity" | "quantityUnit"> &
    Partial<Pick<GrossMarginCalculationLine, "optionId" | "optionName">>
): GrossMarginCalculationLine {
  return {
    label: input.service,
    optionId: input.optionId || input.service,
    optionName: input.optionName || input.service,
    unitPrice: 0,
    total: 0,
    ...input
  };
}

function makeCalculation(lines: GrossMarginCalculationLine[]): GrossMarginCalculationResult {
  return {
    originalPrice: 1_000,
    discountPrice: 800,
    maintenanceCost: 100,
    grossProfit: 700,
    grossMarginRate: 0.7,
    rebateRate: 0.2,
    lines
  };
}
