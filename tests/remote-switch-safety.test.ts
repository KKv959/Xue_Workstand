import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../scripts/remote-server.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("remote-server.mjs", source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["assertNoActiveJobs", "fetchJson"].includes(node.name?.text || ""))
  .map(node => node.getText(ast)).join("\n");

test("本机正式服务可首次安装并复用已有版本，不要求额外网络入口", async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "workbench-service-setup-"));
  const launchAgentPath = path.join(temporaryRoot, "LaunchAgents", "workbench.plist");
  const setupSource = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "setup")!.getText(ast);
  try {
    for (const hasRelease of [false, true]) {
      const commands: string[][] = [];
      let starts = 0;
      const setup = vm.runInNewContext(setupSource + "\nsetup", {
        fs, path, process: { platform: "darwin", pid: process.pid },
        releasesRoot: path.join(temporaryRoot, "releases"), launchAgentPath,
        currentLink: path.join(temporaryRoot, "current"),
        capture: (executable: string, args: string[]) => {
          commands.push([executable, ...args]);
          return { ok: true };
        },
        launchAgentPlist: () => "local-service-config",
        exists: async () => hasRelease,
        start: async () => { starts += 1; },
        console: { log: () => undefined }
      }) as () => Promise<void>;
      await setup();
      assert.equal(await fs.promises.readFile(launchAgentPath, "utf8"), "local-service-config");
      assert.deepEqual(commands, [["/usr/bin/env", "which", "node"], ["/usr/bin/env", "which", "caffeinate"]]);
      assert.equal(starts, hasRelease ? 1 : 0);
      assert.deepEqual(await fs.promises.readdir(path.dirname(launchAgentPath)), ["workbench.plist"]);
    }
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

// Evaluate the real guard without invoking launchctl, deployment or a live workbench.
function guard(response: unknown, portOpen = false) {
  return vm.runInNewContext(functions + "\nassertNoActiveJobs", {
    fetch: async () => { if (response instanceof Error) throw response; return response; },
    isTcpPortOpen: async () => portOpen,
    AbortController, setTimeout, clearTimeout,
    describeError: (error: Error) => error.message
  }) as () => Promise<void>;
}

test("切换仅在确认服务未监听时允许冷启动，运行中不可读的服务保持阻断", async () => {
  for (const [refused, portOpen, allowed] of [[true, false, true], [true, true, false], [false, false, false]] as const) {
    const run = guard(Object.assign(new Error("连接失败"), { cause: { code: refused ? "ECONNREFUSED" : "ETIMEDOUT" } }), portOpen);
    if (allowed) await run();
    else await assert.rejects(run(), /无法确认任务状态/);
  }
});

test("任务读取、恢复、结构异常和运行任务阻断切换，完整终态列表允许切换", async () => {
  const healthy = { jobs: [], readErrors: [], recoveryErrors: {} };
  for (const data of [
    { ...healthy, readErrors: ["记录损坏"] },
    { ...healthy, recoveryErrors: { job: "恢复失败" } },
    { jobs: [] }, null,
    { ...healthy, recoveryErrors: [] },
    { ...healthy, jobs: [null] },
    { ...healthy, jobs: [{ status: "unknown" }] },
    { ...healthy, jobs: [{ status: "running" }] },
    { ...healthy, jobs: [{ status: "queued" }] }
  ]) {
    await assert.rejects(guard(Response.json(data))(), /已停止切换|运行或排队任务/);
  }
  await guard(Response.json({ ...healthy, jobs: ["completed", "failed", "cancelled", "interrupted"].map(status => ({ status })) }))();
});
