import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("首次历史任务只建基线，进入页面后落盘及后续完成仍失效缓存", () => {
  const source = readFileSync("src/components/TaskProvider.tsx", "utf8");
  const ast = ts.createSourceFile("TaskProvider.tsx", source, ts.ScriptTarget.Latest, true);
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "handleJobDataSync").map(node => node.getText(ast)).join("\n");
  const invalidated: string[] = [];
  let refreshes = 0;
  const sync = vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + "\nhandleJobDataSync", {
    invalidateJobClientCaches: (job: { id: string }) => { invalidated.push(job.id); return true; }, invalidateLibraryOverviewCache: () => {}
  });
  const now = Date.now();
  const old = { id: "old", status: "completed", dataRevision: 1, updatedAt: new Date(now - 1000).toISOString() };
  const revisions = new Map();
  const refresh = async () => { refreshes++; };
  sync([old], true, new Map(), revisions, refresh, now);
  assert.equal(refreshes, 0);
  assert.equal(revisions.get("old"), 1);
  const completed = { ...old, id: "new", updatedAt: new Date(now + 1).toISOString() };
  sync([old, completed], true, new Map(), revisions, refresh, now);
  assert.deepEqual(invalidated, ["new"]);
  sync([{ ...completed, dataRevision: 2 }], false, new Map([["new", "running"]]), revisions, refresh, now);
  assert.deepEqual(invalidated, ["new", "new"]);
  assert.equal(refreshes, 2);
});
