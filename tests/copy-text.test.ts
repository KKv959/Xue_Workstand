import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "../src/lib/copy-text";

test("同步复制成功无需权限；失败尝试标准接口，并清理焦点", async () => {
  const keys = ["document", "navigator", "HTMLElement"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    for (const mode of ["success", "false", "throw"]) {
      let selected = false, removed = false, focused = false, writes = 0;
      class Element { focus() { focused = true; } }
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Element });
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        activeElement: new Element(), body: { appendChild() {} },
        createElement: () => ({ value: "", readOnly: false, style: {}, select() { selected = true; }, remove() { removed = true; } }),
        execCommand: () => { assert.equal(selected, true); if (mode === "throw") throw new Error(); return mode === "success"; }
      } });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { assert.equal(value, "文案"); writes++; } } } });
      await copyText("文案");
      assert.equal(writes, mode === "success" ? 0 : 1);
      assert.ok(removed && focused);
    }
  } finally {
    keys.forEach((key, i) => { if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!); else Reflect.deleteProperty(globalThis, key); });
  }
});
