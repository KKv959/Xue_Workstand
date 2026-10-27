import assert from "node:assert/strict";
import test from "node:test";
import { applyDefaultCollectionDateRange, type CollectAccountInput } from "../src/lib/account-collection";

const input: CollectAccountInput = { platform: "douyin", name: "测试账号", limit: 20, order: "likes" };

test("抖音不限时间默认最近五个日历年", () => {
  const result = applyDefaultCollectionDateRange(input, new Date(2026, 8, 22));
  assert.equal(result.fromDate, "2021-09-22");
  assert.equal(result.toDate, "2026-09-22");
  assert.equal(input.fromDate, undefined);
});

test("明确日期范围保持原样，闰年边界合法", () => {
  for (const range of [{ fromDate: "2020-01-01" }, { toDate: "2020-12-31" }]) {
    const explicit = { ...input, ...range };
    assert.equal(applyDefaultCollectionDateRange(explicit), explicit);
  }
  assert.equal(applyDefaultCollectionDateRange(input, new Date(2024, 1, 29)).fromDate, "2019-02-28");
  const bilibili = { ...input, platform: "bilibili" as const };
  assert.equal(applyDefaultCollectionDateRange(bilibili), bilibili);
});
