import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultGrossMarginReviewTemplate, grossMarginReviewTemplateVariables, renderGrossMarginReviewTemplate, validateGrossMarginReviewTemplate } from "../src/lib/gross-margin-template";

test("日期字段按北京时间取当天日期，跨日自动更新且不使用传入旧值", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-13T16:00:00.000Z") });
  assert.equal(validateGrossMarginReviewTemplate("申请日期：{{date}}"), "申请日期：{{date}}");
  assert.equal(renderGrossMarginReviewTemplate("申请日期：{{date}}\n日期：{{ date }}", { date: "旧日期" }),
    "申请日期：2026年10月14日\n日期：2026年10月14日");
  context.mock.timers.setTime(new Date("2026-10-14T16:00:00.000Z").getTime());
  assert.equal(renderGrossMarginReviewTemplate("申请日期：{{date}}", {}), "申请日期：2026年10月15日");
  context.mock.timers.setTime(new Date("2026-01-01T00:00:00.000Z").getTime());
  assert.equal(renderGrossMarginReviewTemplate("{{date}}", {}), "2026年1月1日");
});

test("未使用日期字段的已有模板保持原样", () => {
  assert.equal(renderGrossMarginReviewTemplate("申请日期：\n账号：{{accountName}}", { accountName: "测试账号" }),
    "申请日期：\n账号：测试账号");
});

test("两个平台支持视频标题和当前播放量，旧审核尾巴仍可保存但不再输出", () => {
  assert.ok(grossMarginReviewTemplateVariables.some(({ name }) => name === "videoTitle"));
  assert.ok(grossMarginReviewTemplateVariables.some(({ name }) => name === "currentPlayValue"));
  assert.ok(!grossMarginReviewTemplateVariables.map(({ label }) => String(label)).includes("审核尾巴"));
  for (const platform of ["douyin", "bilibili"] as const) {
    const template = getDefaultGrossMarginReviewTemplate(platform);
    assert.ok(!template.includes("reviewFooter"));
    const text = renderGrossMarginReviewTemplate(`${template}\n{{ reviewFooter }}`, {
      videoTitle: "真实视频标题", currentPlayValue: 12345, playValue: "10万"
    });
    assert.ok(text.includes("视频标题：真实视频标题"));
    assert.ok(text.includes("当前播放量：12345"));
    assert.ok(text.includes("10万"));
    assert.ok(!text.includes("reviewFooter"));
    assert.ok(!text.includes("辛苦审核"));
  }
});
