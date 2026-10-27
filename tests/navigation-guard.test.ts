import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("写作台离页时仍暂存输入，但不阻止刷新或关闭", () => {
  const document = new EventTarget();
  const window = new EventTarget();
  const stored = new Map<string, string>();
  const cleanups: (() => void)[] = [];
  Object.assign(window, { sessionStorage: { setItem: (key: string, value: string) => stored.set(key, value) } });
  const exports = {} as { useWriterSessionSave: (key: string, enabled: boolean, input: object, onError: (message: string) => void) => void };
  const source = readFileSync(new URL("../src/app/writer/_hooks/useWriterSessionSave.ts", import.meta.url), "utf8");
  const effect = (callback: () => (() => void) | undefined) => {
    const cleanup = callback();
    if (cleanup) cleanups.push(cleanup);
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports, document, window, setTimeout, clearTimeout,
    require: () => ({ useEffect: effect, useLayoutEffect: effect, useRef: (current: unknown) => ({ current }) }) });

  const input = { styleRefs: [], prompt: "尚未生成的输入", sourceText: "素材", useWebResearch: false, revisionInstruction: "续改要求", revisionMode: "edit" };
  exports.useWriterSessionSave("writer-session", true, input, (message) => assert.fail(message));
  try {
    const unload = new Event("beforeunload", { cancelable: true });
    assert.equal(window.dispatchEvent(unload), true, "刷新和关闭不得被拦截");
    assert.equal(unload.defaultPrevented, false);
    assert.deepEqual(JSON.parse(stored.get("writer-session")!), input, "离页前必须完成输入暂存");
  } finally {
    cleanups.forEach(cleanup => cleanup());
  }
});
