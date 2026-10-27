import assert from "node:assert/strict";
import test from "node:test";
import { getGrossMarginAccountDisplayName, getGrossMarginAccountNameOptions, getGrossMarginAccountOptions, normalizeGrossMarginAccountName } from "../src/lib/gross-margin-account-names";
import { findGrossMarginAccount } from "../src/app/gross-margin/_lib/gross-margin-workbench-model";
import { findGrossMarginProjectOrders, parseWecomProjectSheet } from "../src/lib/gross-margin-projects";
import { parseWecomAccountSheet } from "../src/lib/wecom-account-source";
import type { GrossMarginAccountPrice } from "../src/lib/types";

test("装饰标点、丶与空格统一匹配，字母数字与有意义的符号保留", () => {
  for (const raw of ["上官北", "上官北丶", " 上 官 北． ", "上官北_", "上官·北"]) assert.equal(normalizeGrossMarginAccountName(raw), "上官北");
  assert.equal(getGrossMarginAccountDisplayName(" 上官北丶 "), "上官北");
  assert.equal(normalizeGrossMarginAccountName("ＵＰ·主"), "up主");
  assert.notEqual(normalizeGrossMarginAccountName("上官北2"), normalizeGrossMarginAccountName("上官北"));
  assert.notEqual(normalizeGrossMarginAccountName("C++"), normalizeGrossMarginAccountName("C"));
  assert.equal(normalizeGrossMarginAccountName("丶---"), "");
});

test("信息表和项目表的不同写法自动匹配同一账号，保留原名、平台和项目身份", () => {
  const accounts = parseWecomAccountSheet([
    "B站", "|账号昵称|平台|UID|植入视频报价;（含税不含平台费）|定制视频报价;（含税不含平台费）|",
    "|---|---|---|---|---|", "|上官北丶|B站|12345|8000|10000|"
  ].join("\n"));
  assert.equal(findGrossMarginAccount(accounts, "上官北")?.bilibiliUid, "12345");
  assert.equal(accounts[0].name, "上官北丶");
  const orders = parseWecomProjectSheet([
    "26.10月", "|平台|账号|投放产品|下单金额|返点金额|最终合作价格|", "|---|---|---|---|---|---|",
    "|B站|上官北丶|项目甲|10000|2000|8000|", "|抖音|上官北|项目乙|10000|2000|8000|", "|B站|上官北2|项目丙|10000|2000|8000|"
  ].join("\n"), "2026-10");
  const original = JSON.stringify(orders);
  for (const name of ["上官北", "上官北丶", "上官北_"]) {
    assert.deepEqual(findGrossMarginProjectOrders(orders, "bilibili", name).map(order => order.projectName), ["项目甲"]);
  }
  assert.equal(orders[0].accountName, "上官北丶");
  assert.equal(JSON.stringify(orders), original);
  assert.equal(findGrossMarginProjectOrders(orders, "bilibili", "上官").length, 0);
  assert.equal(findGrossMarginAccount([{...accounts[0], name:"丶---"}], "上官北"), null);
});

test("账号选项按统一名称去重，报价与平台保留，源记录不重写", () => {
  const account: GrossMarginAccountPrice = {platform:"bilibili",name:"上官北丶",defaultPrice:10000,priceLabel:"定制报价",bilibiliUid:"12345"};
  const accounts = [account,{...account,name:"上官北"},{...account,platform:"douyin" as const}];
  const original = JSON.stringify(accounts);
  const options = getGrossMarginAccountOptions(accounts);
  assert.equal(options.length, 2);
  assert.ok(options.every(option => option.name === "上官北" && option.defaultPrice === 10000));
  assert.equal(JSON.stringify(accounts), original);
  assert.deepEqual(getGrossMarginAccountNameOptions(["上官北丶", "上官北", "上官北_", "丶---"]), [{value:"上官北",label:"上官北"}]);
});
