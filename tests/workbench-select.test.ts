import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import ts from "typescript";
import * as accountNames from "../src/lib/gross-margin-account-names";

// 检查真实组件传给现成控件的集合和回调，不启动浏览器或外部能力。
function load(file: string, expose = "") {
  const compiled = { exports: {} as Record<string, (props: Record<string, unknown>) => React.ReactElement> };
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8") + (expose ? `\nexport { ${expose} };` : ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, { module: compiled, exports: compiled.exports, require(name: string) {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react-aria-components" || name === "lucide-react") return new Proxy({}, { get: (_, key) => String(key) });
    if (name === "@/lib/gross-margin-account-names") return accountNames;
    if (name.startsWith("@/") || name === "../_lib/gross-margin-workbench-model") return new Proxy({}, { get: (_, key) => String(key) });
    throw new Error(`未 mock 的依赖：${name}`);
  } });
  return compiled.exports;
}

type Element = React.ReactElement<Record<string, unknown>>;
function find(element: Element, type: string): Element {
  if (element.type === type) return element;
  for (const child of React.Children.toArray(element.props.children as React.ReactNode)) {
    if (React.isValidElement(child)) {
      try { return find(child as Element, type); } catch { /* 继续搜索兄弟控件。 */ }
    }
  }
  throw new Error(`缺少 ${type}`);
}

test("统一下拉保留空值、文本、禁用项和选择回调", () => {
  let selected = "initial";
  const tree = load("src/components/WorkbenchSelect.tsx").WorkbenchSelect({ value: "", "aria-label": "分类", onValueChange: (value: string) => { selected = value; },
    children: [React.createElement("option", { value: "", key: "all" }, "全部"), React.createElement("option", { value: "x", disabled: true, key: "x" }, "测试", 2)] }) as Element;
  const items = find(tree, "ListBox").props.items;
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [{ value: "", label: "全部" }, { value: "x", label: "测试2", disabled: true }]);
  (find(tree, "Select").props.onChange as (value: string) => void)("");
  assert.equal(selected, "");
});

test("账号搜索保留空白归一化、手动输入和选择的共用回调", () => {
  let value = "";
  const accounts = [{ name: "A B账号", platform: "bilibili" }];
  const tree = load("src/app/gross-margin/_components/GrossMarginMaintenancePane.tsx", "GrossMarginAccountCombobox")
    .GrossMarginAccountCombobox({ accounts, busy: false, value, onChange: (next: string) => { value = next; } }) as Element;
  const combo = find(tree, "ComboBox").props;
  const filter = combo.defaultFilter as (name: string, query: string) => boolean;
  assert.equal(filter("A B账号", " ab "), true);
  assert.equal(filter("A B账号", "其他"), false);
  assert.equal(filter("上官北丶", "上官北"), true);
  assert.equal(filter("上官北", "上官北丶"), true);
  assert.equal(combo.allowsCustomValue, true);
  assert.equal(combo.defaultItems, accounts);
  (combo.onInputChange as (value: string) => void)("A B账号");
  assert.equal(value, "A B账号");
});

test("页面下拉统一接入 WorkbenchSelect，避免再次绕过浮层定位", () => {
  for (const file of readdirSync("src", { recursive: true }).filter(file => typeof file === "string" && file.endsWith(".tsx"))) {
    const source = ts.createSourceFile(`src/${file}`, readFileSync(`src/${file}`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        assert.notEqual(node.tagName.getText(source), "select", `${file} 应复用统一下拉`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
