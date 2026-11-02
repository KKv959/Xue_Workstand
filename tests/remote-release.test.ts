import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { withJobAdmission, pendingJobCreations } from "../src/lib/service-transition";
import { GET as readiness } from "../src/app/api/remote/ready/route";

const helpers = await import(new URL("../scripts/lib/remote-release.mjs", import.meta.url).href);
const source = fs.readFileSync(new URL("../scripts/remote-server.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("remote-server.mjs", source, ts.ScriptTarget.Latest, true);
function script(name: string, bindings: Record<string, unknown> = {}, extra: string[] = []) {
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && [name, ...extra].includes(node.name?.text || ""))
    .map(node => node.getText(ast)).join("\n");
  return vm.runInNewContext(code + `\n${name}`, {
    fs, path, os, process, setTimeout, console: { log() {}, warn() {}, error() {} },
    ...helpers,
    exists: async (file: string) => fs.existsSync(file),
    describeError: (error: Error) => error.message,
    ...bindings
  });
}
async function temporary(run: (root: string) => Promise<void>) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "release-test-"));
  try { await run(root); }
  finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}

test("候选指纹覆盖源码、依赖、配置、环境和工具版本，拒绝源码符号链接", async () => temporary(async root => {
  const fingerprint = () => helpers.releaseInputs(root, { CUSTOM: "one" }, "10");
  for (const file of ["src/app.ts", "package-lock.json", ".env.local", ".npmrc", "tests/new.test.ts"]) {
    const before = await fingerprint();
    await fs.promises.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.promises.writeFile(path.join(root, file), "changed");
    assert.notEqual((await fingerprint()).fingerprint, before.fingerprint, file);
  }
  const current = await fingerprint();
  assert.notEqual((await helpers.releaseInputs(root, { CUSTOM: "two" }, "10")).fingerprint, current.fingerprint);
  assert.notEqual((await helpers.releaseInputs(root, { CUSTOM: "one" }, "11")).fingerprint, current.fingerprint);
  await fs.promises.symlink("../package-lock.json", path.join(root, "src/link"));
  await assert.rejects(fingerprint(), /符号链接/);
}));

test("只有验证完成且完整产物未被改动的候选可复用", async () => temporary(async root => {
  const release = path.join(root, "releases", "build-1");
  await fs.promises.mkdir(release, { recursive: true });
  await fs.promises.mkdir(path.join(release, ".next"));
  await fs.promises.writeFile(path.join(release, "server.js"), "server");
  await helpers.writeJsonAtomic(path.join(release, "REMOTE_BUILD.json"), { buildId: "build-1", fingerprint: "input" });
  const candidate = { schemaVersion: 1, buildId: "build-1", fingerprint: "input", validation: "passed", artifactDigest: await helpers.hashArtifact(release) };
  await helpers.writeJsonAtomic(path.join(root, "candidate.json"), candidate);
  assert.ok(await helpers.readCandidate(root, "input"));
  await fs.promises.mkdir(path.join(release, ".next/cache"));
  await fs.promises.writeFile(path.join(release, ".next/cache/image"), "runtime cache");
  assert.ok(await helpers.readCandidate(root, "input"));
  assert.equal(await helpers.readCandidate(root, "other"), null);
  await fs.promises.writeFile(path.join(release, "HEALTHY"), "now");
  assert.ok(await helpers.readCandidate(root, "input"));
  await fs.promises.writeFile(path.join(release, "FAILED"), "failed");
  assert.equal(await helpers.readCandidate(root, "input"), null);
  await fs.promises.rm(path.join(release, "FAILED"));
  await fs.promises.writeFile(path.join(release, "server.js"), "tampered");
  assert.equal(await helpers.readCandidate(root, "input"), null);
  await helpers.writeJsonAtomic(path.join(root, "candidate.json"), { ...candidate, buildId: "../escape" });
  assert.equal(await helpers.readCandidate(root, "input"), null);
}));

test("构建隔离运行测试/lint/类型检查，失败不生成候选，成功记录产物", async () => temporary(async root => {
  const stateRoot = path.join(root, ".remote-server");
  const inputs = await helpers.releaseInputs(root, process.env, "10");
  const commands: string[] = [];
  let fail = true;
  const build = script("buildRelease", {
    root, stateRoot, releasesRoot: path.join(stateRoot, "releases"),
    capture: () => ({ stdout: "abc" }), makeBuildId: () => "build-1", readPackageVersion: () => "1",
    timed: (_label: string, action: () => Promise<unknown>) => action(),
    run: async (_executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      commands.push(args.join(" "));
      assert.notEqual(options.cwd, root);
      assert.notEqual(options.env.STYLE_LIBRARY_DIR, path.join(root, "style-library"));
      if (args[0] === "test" && fail) throw new Error("test failed");
      if (args[1] === "build") {
        await fs.promises.mkdir(path.join(options.cwd, ".next/standalone"), { recursive: true });
        await fs.promises.mkdir(path.join(options.cwd, ".next/static"));
        await fs.promises.writeFile(path.join(options.cwd, ".next/standalone/server.js"), "built");
      }
    }
  });
  await assert.rejects(build(inputs, "10"), /test failed/);
  assert.equal(await helpers.readCandidate(stateRoot, inputs.fingerprint), null);
  fail = false;
  commands.length = 0;
  await build(inputs, "10");
  assert.deepEqual(commands, ["ci --include=dev --prefer-offline --no-audit --no-fund", "test", "run lint", "run build -- --no-lint"]);
  assert.ok(await helpers.readCandidate(stateRoot, inputs.fingerprint));
}));

test("构建后任务阻断保留候选，重试不重复安装构建且仍检查资料库和任务", async () => {
  let builds = 0, checks = 0, activations = 0, blocked = true;
  let candidate: { buildId: string; releaseRoot: string } | null = null;
  const deploy = script("deploy", {
    root: "/isolated", stateRoot: "/isolated/.remote-server", launchAgentPath: "/isolated/agent", healthUrl: "http://fixture/status",
    exists: async () => true, capture: () => ({ ok: true, stdout: "10" }),
    releaseInputs: async () => ({ fingerprint: "same" }), readCandidate: async () => candidate,
    buildRelease: async () => { builds++; return candidate = { buildId: "new", releaseRoot: "/releases/new" }; },
    timed: (_label: string, action: () => Promise<unknown>) => action(), run: async () => { checks++; },
    currentReleasePath: async () => "/releases/old", isHealthyRelease: async () => true,
    assertNoActiveJobs: async () => { if (blocked) throw new Error("运行或排队任务"); },
    fetchJson: async () => ({ ok: true, data: {} }), withTaskProtection: async (action: () => Promise<unknown>) => action(),
    activateWithRecovery: async () => { activations++; }, pruneReleases: async () => undefined
  });
  await assert.rejects(deploy(), /候选 new 已保留/);
  assert.equal(activations, 0);
  blocked = false;
  await deploy();
  assert.equal(builds, 1);
  assert.equal(checks, 2);
  assert.equal(activations, 1);
});

test("切换入口统一上锁，任务门禁拒绝新请求并在失败后释放", async () => temporary(async root => {
  const previous = process.env.WORKBENCH_SOURCE_ROOT;
  process.env.WORKBENCH_SOURCE_ROOT = root;
  try {
    let finish!: () => void;
    const creation = withJobAdmission(() => new Promise<void>(resolve => { finish = resolve; }));
    assert.equal(pendingJobCreations(), 1);
    const gate = script("withTaskProtection", {
      stateRoot: path.join(root, ".remote-server"), assertNoActiveJobs: async () => {
        await assert.rejects(withJobAdmission(async () => "new"), /服务正在切换/);
        assert.equal(pendingJobCreations(), 1);
        throw new Error("创建中");
      }
    });
    await assert.rejects(gate(async () => assert.fail("must not switch")), /创建中/);
    assert.equal(fs.existsSync(path.join(root, ".remote-server/switching.json")), false);
    finish(); await creation;
    assert.equal(pendingJobCreations(), 0);
    await assert.rejects(withJobAdmission(async () => { throw new Error("create failed"); }), /create failed/);
    assert.equal(pendingJobCreations(), 0);
    assert.equal(await withJobAdmission(async () => "accepted"), "accepted");
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_SOURCE_ROOT;
    else process.env.WORKBENCH_SOURCE_ROOT = previous;
  }
  assert.match(source, /\["setup", "start", "stop", "dev", "deploy", "rollback"\].*withServiceLock/);
}));

test("macOS 服务锁拒绝并发并在异常后释放", { skip: process.platform !== "darwin" }, async () => temporary(async root => {
  const lock = script("withServiceLock", {
    stateRoot: root,
    capture: (bin: string, args: string[]) => ({ ok: spawnSync(bin, args).status === 0 })
  });
  await assert.rejects(lock(async () => {
    await assert.rejects(lock(async () => assert.fail("concurrent")), /已有服务操作/);
    throw new Error("operation failed");
  }), /operation failed/);
  assert.equal(fs.existsSync(path.join(root, "service.lock")), false);
  assert.equal(await lock(async () => 42), 42);
}));

test("应用探针不调用外部依赖，存储缺失明确返回 503", async () => temporary(async root => {
  const before = { STYLE_LIBRARY_DIR: process.env.STYLE_LIBRARY_DIR, APP_BUILD_ID: process.env.APP_BUILD_ID };
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, APP_BUILD_ID: "expected" });
  try {
    const response = await readiness();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).buildId, "expected");
    process.env.STYLE_LIBRARY_DIR = path.join(root, "missing");
    assert.equal((await readiness()).status, 503);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}));

test("健康检查核对准确版本，仅 404 才采用无缓存的旧版探针", async () => {
  const expected = { ready: true, storage: "ok", appMode: "workspace", serviceMode: "production", buildId: "new" };
  for (const data of [expected, { ...expected, buildId: "old" }, { ...expected, storage: "unavailable" }, { ...expected, serviceMode: "development" }]) {
    const wait = script("waitForHealth", { readyUrl: "ready", healthUrl: "status", fetchJson: async () => ({ ok: true, data }) });
    assert.equal(await wait(10, "new"), data === expected);
  }
  const urls: string[] = [];
  const wait = script("waitForHealth", { readyUrl: "ready", healthUrl: "status", fetchJson: async (url: string) => {
    urls.push(url);
    return url === "ready" ? { ok: false, status: 404 } : { ok: true, data: { app: { buildId: "old", appMode: "workspace", status: "degraded" }, services: { storage: { status: "ok" } } } };
  } });
  assert.equal(await wait(100, "old"), true);
  assert.deepEqual(urls, ["ready", "status?fresh=1"]);
});

test("既有依赖异常和 Chrome 离线明确告警，新增能力故障复查后阻断", async () => {
  const names = ["opencli", "browserBridge", "ffmpeg", "chat", "image"];
  const healthy = { services: Object.fromEntries(names.map(name => [name, { status: "ok" }])) };
  let current = healthy, checks = 0, recover = false;
  const warnings: string[] = [];
  const report = script("reportDependencies", {
    dependencyNames: names, healthUrl: "status", console: { warn: (message: string) => warnings.push(message) },
    fetchJson: async () => { checks++; return { ok: true, data: recover && checks > 1 ? healthy : current }; }
  });
  current = { services: { ...healthy.services, browserBridge: { status: "unavailable" } } };
  await report(healthy);
  assert.ok(warnings.some(value => value.includes("browserBridge")));
  current = { services: { ...healthy.services, opencli: { status: "unavailable" } } };
  await report(current); // 既有异常
  checks = 0;
  await assert.rejects(report(healthy), /持续出现新增异常：opencli/);
  assert.equal(checks, 2);
  recover = true; checks = 0;
  await report(healthy);
});

test("恢复区分成功、失败和任务保护阻断，并验证恢复的确切版本", async () => temporary(async root => {
  const target = path.join(root, "new"), previous = path.join(root, "old");
  await fs.promises.mkdir(target); await fs.promises.mkdir(previous);
  for (const mode of ["recovered", "failed", "blocked"]) {
    const verified: string[] = [], activated: string[] = [];
    const activate = script("activateWithRecovery", {
      errorLogFile: "fixture.log", isHealthyRelease: async () => true,
      activateRelease: async (value: string) => { activated.push(value); }, switchToProduction: async () => undefined,
      requireHealthy: async (value: string) => { verified.push(value); if (value === target || mode === "failed") throw new Error("unhealthy"); },
      assertNoActiveJobs: async () => { if (mode === "blocked") throw new Error("任务运行中"); }, reportDependencies: async () => undefined
    });
    await assert.rejects(activate(target, previous, null, "发布"), mode === "recovered" ? /发布失败.*已恢复并验证上一版本 old/ : /发布失败.*恢复失败/);
    assert.deepEqual(verified, mode === "blocked" ? [target] : [target, previous]);
    assert.deepEqual(activated, mode === "blocked" ? [target] : [target, previous]);
    assert.ok(fs.existsSync(path.join(target, "FAILED")));
  }
}));

test("清理保留上一健康版本，不保留更新但失败的目录", async () => temporary(async root => {
  const releasesRoot = path.join(root, "releases");
  for (const name of ["current", "healthy", "newer-failed"]) {
    const dir = path.join(releasesRoot, name);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "server.js"), "server");
    await fs.promises.writeFile(path.join(dir, "HEALTHY"), "now");
    await helpers.writeJsonAtomic(path.join(dir, "REMOTE_BUILD.json"), { buildId: name });
  }
  await fs.promises.writeFile(path.join(releasesRoot, "newer-failed/FAILED"), "failed");
  const prune = script("pruneReleases", {
    releasesRoot, currentReleasePath: async () => path.join(releasesRoot, "current")
  }, ["listReleases", "isHealthyRelease", "readReleaseBuild", "previousHealthyRelease"]);
  await prune(path.join(releasesRoot, "newer-failed"));
  assert.deepEqual((await fs.promises.readdir(releasesRoot)).sort(), ["current", "healthy"]);
}));

test("启停及模式入口在任务保护通过前没有服务副作用", async () => {
  const entry = ast.statements.find(ts.isTryStatement)!.getText(ast);
  for (const command of ["setup", "start", "stop", "dev"]) {
    const events: string[] = [];
    const fakeProcess = { exitCode: 0 };
    await vm.runInNewContext(`(async () => { ${entry} })()`, {
      command, process: fakeProcess, console: { error() {} }, describeError: (error: Error) => error.message,
      withServiceLock: async (action: () => Promise<unknown>) => { events.push("lock"); return action(); },
      withTaskProtection: async () => { events.push("guard"); throw new Error("任务状态不安全"); },
      main: async () => { events.push("side effect"); }
    });
    assert.deepEqual(events, ["lock", "guard"], command);
    assert.equal(fakeProcess.exitCode, 1);
  }
});

test("bootstrap 成功不重复 kickstart，启动失败不能被忽略", async () => {
  const calls: string[] = [];
  const bootstrap = script("bootstrapLaunchAgent", {
    launchAgentPath: "fixture", launchDomain: () => "domain", launchTarget: () => "target",
    capture: (_bin: string, args: string[]) => { calls.push(args[0]); return { ok: true }; }
  });
  await bootstrap();
  assert.deepEqual(calls, ["bootstrap"]);
  const stop = script("stopLaunchAgent", {
    launchTarget: () => "target", summarizeOutput: (value: string) => value,
    capture: (_bin: string, args: string[]) => ({ ok: args[0] === "print", stdout: "", stderr: "permission denied" })
  });
  await assert.rejects(stop(), /停止 LaunchAgent 失败/);
});

test("Chrome doctor 的 disconnected / not connected 不被误识别为 connected", async () => {
  const file = fs.readFileSync(new URL("../src/lib/remote-status.ts", import.meta.url), "utf8");
  const statusAst = ts.createSourceFile("remote-status.ts", file, ts.ScriptTarget.Latest, true);
  const checkSource = statusAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "checkBrowserBridge")!.getText(statusAst);
  const compiled = ts.transpileModule(checkSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [output, expected] of [
    ["Browser Bridge: connected", "ok"], ["Extension: 已连接", "ok"],
    ["Browser Bridge: disconnected", "unavailable"], ["Extension: not connected", "unavailable"], ["Extension: 未连接", "unavailable"],
    [JSON.stringify({ ok: true, data: { daemonRunning: true, extensionConnected: true, connectivity: { ok: true } } }), "ok"],
    [JSON.stringify({ ok: true, data: { daemonRunning: true, extensionConnected: false, connectivity: { ok: true } } }), "unavailable"],
    [JSON.stringify({ ok: true, data: { daemonRunning: true, extensionConnected: true, connectivity: { ok: false } } }), "unavailable"],
    [JSON.stringify({ ok: false, data: { daemonRunning: true, extensionConnected: true, connectivity: { ok: true } } }), "unavailable"],
    [JSON.stringify({ ok: true, data: {} }), "unavailable"],
    ['{"extensionConnected": true, "message": "Browser Bridge: connected"', "unavailable"]
  ]) {
    const check = vm.runInNewContext(compiled + "\ncheckBrowserBridge", {
      process: { env: {} }, resolveOpenCliCommand: () => ({ command: "mock", argsPrefix: [] }),
      execFileAsync: async () => ({ stdout: output, stderr: "" }), service: (status: string) => ({ status })
    });
    assert.equal((await check(true)).status, expected, output);
  }
});

test("成功激活验证目标后才写健康标记；同版本清理仍保留上一健康版本", async () => temporary(async root => {
  const target = path.join(root, "new"), previous = path.join(root, "old");
  await fs.promises.mkdir(target); await fs.promises.mkdir(previous);
  const events: string[] = [];
  const activate = script("activateWithRecovery", {
    activateRelease: async () => { events.push("activate"); }, switchToProduction: async () => { events.push("start"); },
    requireHealthy: async (value: string) => { assert.equal(value, target); events.push("ready"); },
    reportDependencies: async () => { assert.equal(fs.existsSync(path.join(target, "HEALTHY")), false); events.push("dependencies"); }
  });
  await activate(target, previous, null, "发布");
  assert.deepEqual(events, ["activate", "start", "ready", "dependencies"]);
  assert.ok(fs.existsSync(path.join(target, "HEALTHY")));
  const prune = script("pruneReleases", {
    currentReleasePath: async () => target, listReleases: async () => [target, previous],
    isHealthyRelease: async () => true, previousHealthyRelease: async () => previous
  });
  await prune(target);
  assert.ok(fs.existsSync(previous));
}));
