import assert from "node:assert/strict";
import test from "node:test";
import { makeDraftTitleFromContent } from "../src/lib/utils";

test("extracts a concise entity and topic title from source material", () => {
  assert.equal(
    makeDraftTitleFromContent("方圆大战，正式打响\n《我的世界》和《光遇》居然官宣联动了？！"),
    "我的世界联动"
  );
});

test("keeps an explicit title instead of replacing it with a quoted entity", () => {
  assert.equal(makeDraftTitleFromContent("标题：方圆联动大战\n《我的世界》和《光遇》官宣联动"), "方圆联动大战");
});
