import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import process from "process";
import { sourceEntries, hashEntries, releaseInputs, hashArtifact, writeJsonAtomic, readCandidate } from "./lib/remote-release.mjs";

const root = process.env.WORKBENCH_SOURCE_ROOT || process.cwd();
const stateRoot = path.join(root, ".remote-server");
const releasesRoot = path.join(stateRoot, "releases");
const currentLink = path.join(stateRoot, "current");
const logFile = path.join(stateRoot, "server.log");
const errorLogFile = path.join(stateRoot, "server-error.log");
const serviceLabel = "com.xjx.account-style-library.remote";
const launchAgentPath = path.join(os.homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`);
const devScript = path.join(root, "scripts", "dev-server.mjs");
const healthUrl = "http://127.0.0.1:3000/api/remote/status";
const command = process.argv[2] || "status";
const readyUrl = "http://127.0.0.1:3000/api/remote/ready";
const dependencyNames = ["opencli", "browserBridge", "ffmpeg", "chat", "image"];


try {
  if (["setup", "start", "stop", "dev", "deploy", "rollback", "build"].includes(command)) await withServiceLock(() => ["build", "deploy", "rollback"].includes(command) ? main() : withTaskProtection(main));
  else await main();
} catch (error) {
  console.error(`远程服务错误：${describeError(error)}`);
  process.exitCode = 1;
}

async function main() {
  if (command === "setup") return setup();
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "status") return status();
  if (command === "dev") return startDevelopment();
  if (command === "build") return prepareRelease();
  if (command === "deploy") return deploy();
  if (command === "rollback") return rollback();
  if (command === "serve") return serve();

  throw new Error("用法：node scripts/remote-server.mjs <setup|start|stop|status|dev|build|deploy|rollback>");
}

async function setup() {
  if (process.platform !== "darwin") {
    throw new Error("本机常驻服务当前只支持 macOS。");
  }
  if (!capture("/usr/bin/env", ["which", "node"]).ok) throw new Error("未检测到 Node.js。");
  if (!capture("/usr/bin/env", ["which", "caffeinate"]).ok) throw new Error("未检测到 macOS caffeinate。");

  await fs.promises.mkdir(releasesRoot, { recursive: true });
  await fs.promises.mkdir(path.dirname(launchAgentPath), { recursive: true });
  const temporaryPath = `${launchAgentPath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, launchAgentPlist(), "utf8");
    await fs.promises.rename(temporaryPath, launchAgentPath);
  } finally {
    // 仅清理本次安装的临时配置，不触碰已安装配置或资料库。
    await fs.promises.rm(temporaryPath, { force: true });
  }
  console.log("本机正式服务运行环境已配置。");
  console.log(`LaunchAgent：${launchAgentPath}`);
  if (await exists(path.join(currentLink, "server.js"))) {
    await start();
  } else {
    console.log("尚无正式构建，请执行：npm run remote:deploy");
  }
}

async function start() {
  const release = await currentReleasePath();
  if (!release || !(await exists(path.join(release, "server.js")))) throw new Error("尚无可运行版本，请先执行 npm run remote:deploy。");
  if (!(await exists(launchAgentPath))) throw new Error("尚未安装 LaunchAgent，请先执行 npm run remote:setup。");
  await switchToProduction();
  await requireHealthy(release);
  await reportDependencies(null);
  console.log("远程正式服务已启动：http://127.0.0.1:3000");
}

async function stop() {
  await stopLaunchAgent();
  console.log("远程正式服务已停止。");
}

async function startDevelopment() {
  await stopLaunchAgent();
  await runNodeScript(devScript, ["start"]);
  console.log("已切换为开发服务：http://127.0.0.1:3000");
}

async function status() {
  const launchAgent = capture("launchctl", ["print", launchTarget()]);
  const health = await fetchJson(healthUrl, 5_000);

  console.log(JSON.stringify({
    launchAgent: {
      installed: await exists(launchAgentPath),
      loaded: launchAgent.ok
    },
    server: {
      healthy: health.ok,
      url: healthUrl,
      response: health.ok ? health.data : undefined,
      error: health.ok ? undefined : health.error
    },
    currentRelease: await currentReleaseName(),
    logFile,
    errorLogFile
  }, null, 2));
}

async function prepareRelease() {
  const npm = capture("npm", ["--version"]);
  if (!npm.ok) throw new Error("无法读取 npm 版本，请检查 Node.js 安装。");
  const config = capture("npm", ["config", "list", "--json"]);
  if (!config.ok) throw new Error("无法读取 npm 配置，未构建或切换。");
  const toolchain = `${npm.stdout.trim()}\n${config.stdout}`;
  const inputs = await releaseInputs(root, process.env, toolchain);
  const candidate = await readCandidate(stateRoot, inputs.fingerprint);
  const build = candidate || await buildRelease(inputs, toolchain);
  console.log(`${candidate ? "复用" : "生成"}已通过构建与类型检查的候选：${build.buildId}`);
  return { inputs, toolchain, build };
}

async function deploy() {
  if (!(await exists(launchAgentPath))) throw new Error("尚未完成远程环境配置，请先执行 npm run remote:setup。");
  const { inputs, toolchain, build } = await prepareRelease();

  // 资料库与运行任务会变化，不复用候选中的旧检查结果。
  await timed("资料库检查", () => run("npm", ["run", "check:library"], {
    cwd: root, env: { ...process.env, STYLE_LIBRARY_DIR: path.join(root, "style-library") }
  }));
  const latest = await releaseInputs(root, process.env, toolchain);
  if (latest.fingerprint !== inputs.fingerprint) throw new Error("构建输入或配置已变化，已保留候选但未切换；再次发布将验证新内容。");
  const previousRelease = await currentReleasePath();
  if (previousRelease === build.releaseRoot && await waitForHealth(3_000, build.buildId)) {
    await reportDependencies(null);
    console.log(`当前已运行目标版本，无需重启：${build.buildId}`);
    return;
  }
  try { await assertNoActiveJobs(); }
  catch (error) { throw new Error(`${describeError(error)}；候选 ${build.buildId} 已保留，条件恢复后再次运行 remote:deploy 可复用。`); }
  const baseline = await fetchJson(`${healthUrl}?fresh=1`, 15_000);
  if (!baseline.ok) console.warn("切换前外部能力状态不可用，无法判断依赖是否为既有异常。");
  const recovery = previousRelease !== build.releaseRoot && await isHealthyRelease(previousRelease) ? previousRelease : await previousHealthyRelease(build.releaseRoot, await listReleases());
  await withTaskProtection(() => activateWithRecovery(build.releaseRoot, recovery, baseline.ok ? baseline.data : null, "发布"));
  try { await pruneReleases(previousRelease); }
  catch (error) { console.warn(`版本已发布，旧产物清理失败：${describeError(error)}`); }
  console.log(`发布成功：${build.buildId}`);
}

async function rollback() {
  await assertNoActiveJobs();
  const current = await currentReleasePath();
  const releases = await listReleases();
  const target = await previousHealthyRelease(current, releases);
  if (!target) throw new Error("没有可回退的健康版本。");
  const baseline = await fetchJson(`${healthUrl}?fresh=1`, 15_000);
  if (!baseline.ok) console.warn("回滚前外部能力状态不可用，无法判断依赖是否为既有异常。");
  await withTaskProtection(() => activateWithRecovery(target, current, baseline.ok ? baseline.data : null, "回滚"));
  console.log(`已回退到：${path.basename(target)}`);
}

async function serve() {
  // 与 Next.js 生产环境保持相同优先级，并展开 .env.local 中的变量引用。
  // 从工作区加载，避免 standalone 发布目录遗漏本机模型配置。
  const { default: nextEnv } = await import("@next/env");
  nextEnv.loadEnvConfig(root, false);
  const releaseRoot = await currentReleasePath();
  if (!releaseRoot || !(await exists(path.join(releaseRoot, "server.js")))) {
    throw new Error("远程服务找不到 current/server.js。");
  }
  const build = await readReleaseBuild(releaseRoot);
  const env = {
    ...process.env,
    WORKBENCH_SOURCE_ROOT: root,
    HOSTNAME: "127.0.0.1",
    PORT: "3000",
    APP_MODE: "workspace",
    APP_START_PATH: "/douyin-hotlist",
    APP_BUILD_ID: build?.buildId || path.basename(releaseRoot),
    APP_STARTED_AT: build?.builtAt || new Date().toISOString(),
    STYLE_LIBRARY_DIR: path.join(root, "style-library")
  };
  const args = [path.join(releaseRoot, "server.js")];

  const child = spawn(process.execPath, args, {
    cwd: releaseRoot,
    env,
    stdio: "inherit"
  });
  const powerAssertion = spawn("/usr/bin/caffeinate", ["-dimsu", "-w", String(process.pid)], {
    cwd: releaseRoot,
    env,
    stdio: "inherit"
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
    if (!powerAssertion.killed) powerAssertion.kill(signal);
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));

  const processes = [{ name: "工作台", child }, { name: "系统保活", child: powerAssertion }];
  const exit = await Promise.race(processes.map(({ name, child: processChild }) => new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("exit", (code, signal) => resolve({ name, code, signal }));
  })));
  forward("SIGTERM");
  if (processes.length > 1 && exit.code !== 0) {
    console.error(`${exit.name}意外退出：code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}`);
  }
  if (exit.code && exit.code !== 0) process.exitCode = exit.code;
}

async function buildRelease(inputs, npmVersion) {
  const workRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "style-workbench-remote-"));
  const stagingRoot = path.join(workRoot, "source");
  const gitCommit = capture("git", ["rev-parse", "--short", "HEAD"]).stdout.trim() || "unknown";
  const dirty = Boolean(capture("git", ["status", "--porcelain"]).stdout.trim());
  const builtAt = new Date().toISOString();
  const buildId = makeBuildId(gitCommit, dirty, builtAt);
  const releaseRoot = path.join(releasesRoot, buildId);
  try {
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    for (const entry of sourceEntries) {
      const source = path.join(root, entry);
      if (await exists(source)) await fs.promises.cp(source, path.join(stagingRoot, entry), { recursive: true });
    }
    if (await hashEntries(stagingRoot, sourceEntries) !== inputs.sourceDigest) throw new Error("复制期间源码发生变化，请重新发布。");
    const buildLibrary = path.join(workRoot, "build-library");
    await fs.promises.mkdir(buildLibrary);
    const env = { ...process.env, WORKSPACE_DEV_SANDBOX: "0", NEXT_TELEMETRY_DISABLED: "1",
      STYLE_LIBRARY_DIR: buildLibrary, APP_MODE: "workspace", APP_START_PATH: "/douyin-hotlist",
      APP_BUILD_ID: buildId, APP_STARTED_AT: builtAt };
    console.log(`准备构建：${buildId}`);
    if (await exists(path.join(root, ".npmrc"))) await fs.promises.copyFile(path.join(root, ".npmrc"), path.join(stagingRoot, ".npmrc"));
    // 测试和 lint 在修改完成时按影响范围执行；生产构建承担完整类型检查。
    await withBuildDependencies(stagingRoot, inputs.dependencyFingerprint, env, () =>
      timed("构建及类型检查", () => run("npm", ["run", "build", "--", "--no-lint"], { cwd: stagingRoot, env: { ...env, NODE_ENV: "production" } })));
    if ((await releaseInputs(root, process.env, npmVersion)).fingerprint !== inputs.fingerprint) throw new Error("验证期间源码或配置发生变化，未生成可复用候选。");
    const standaloneRoot = path.join(stagingRoot, ".next", "standalone");
    if (!(await exists(path.join(standaloneRoot, "server.js")))) throw new Error("构建完成但没有生成 .next/standalone/server.js。");
    await fs.promises.mkdir(releasesRoot, { recursive: true });
    await fs.promises.mkdir(releaseRoot, { recursive: false });
    await fs.promises.cp(standaloneRoot, releaseRoot, { recursive: true });
    await fs.promises.mkdir(path.join(releaseRoot, ".next"), { recursive: true });
    await fs.promises.cp(path.join(stagingRoot, ".next", "static"), path.join(releaseRoot, ".next", "static"), { recursive: true });
    if (await exists(path.join(stagingRoot, "public"))) await fs.promises.cp(path.join(stagingRoot, "public"), path.join(releaseRoot, "public"), { recursive: true });
    await writeJsonAtomic(path.join(releaseRoot, "REMOTE_BUILD.json"), {
      buildId, version: readPackageVersion(), gitCommit, dirty, builtAt, fingerprint: inputs.fingerprint
    });
    const candidate = { schemaVersion: 1, buildId, fingerprint: inputs.fingerprint,
      validation: "build-passed", validatedAt: new Date().toISOString(), artifactDigest: await hashArtifact(releaseRoot) };
    await writeJsonAtomic(path.join(stateRoot, "candidate.json"), candidate);
    return { ...candidate, releaseRoot };
  } finally {
    await fs.promises.rm(workRoot, { recursive: true, force: true });
  }
}

async function withBuildDependencies(stagingRoot, fingerprint, env, build) {
  const cacheRoot = path.join(stateRoot, "build-dependencies");
  const cachedModules = path.join(cacheRoot, "node_modules");
  const modules = path.join(stagingRoot, "node_modules");
  const marker = path.join(cacheRoot, "fingerprint");
  const previous = await fs.promises.readFile(marker, "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  let ready = false;
  try {
    await timed("准备构建依赖", async () => {
      if (previous === fingerprint && await exists(cachedModules)) {
        // 发布锁保证串行；移动目录避免复制依赖，也不与开发服务共享 node_modules。
        await fs.promises.rename(cachedModules, modules);
        console.log("复用构建依赖，无需 npm ci。");
      } else {
        await run("npm", ["ci", "--include=dev", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: stagingRoot, env });
      }
    });
    ready = true;
    await fs.promises.rm(path.join(stagingRoot, ".npmrc"), { force: true });
    return await build();
  } finally {
    if (ready) {
      try {
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        await fs.promises.rm(marker, { force: true });
        await fs.promises.rm(cachedModules, { recursive: true, force: true });
        await fs.promises.rename(modules, cachedModules);
        await fs.promises.writeFile(marker, fingerprint, "utf8");
      } catch (error) {
        console.warn(`构建依赖缓存保存失败，下次将重新安装：${describeError(error)}`);
      }
    }
  }
}

async function switchToProduction() {
  await runNodeScript(devScript, ["stop"]);
  await stopLaunchAgent();
  if (!(await exists(launchAgentPath))) {
    await fs.promises.mkdir(path.dirname(launchAgentPath), { recursive: true });
    await fs.promises.writeFile(launchAgentPath, launchAgentPlist(), "utf8");
  }
  if (await isTcpPortOpen(3000)) throw new Error("3000 端口仍被占用，已停止切换。");
  await bootstrapLaunchAgent();
}

async function activateRelease(releaseRoot) {
  await fs.promises.mkdir(stateRoot, { recursive: true });
  const temporaryLink = path.join(stateRoot, `.current-${process.pid}-${Date.now()}`);
  await fs.promises.rm(temporaryLink, { force: true, recursive: true });
  await fs.promises.symlink(releaseRoot, temporaryLink, "dir");
  await fs.promises.rename(temporaryLink, currentLink);
}

async function stopLaunchAgent() {
  const wasLoaded = capture("launchctl", ["print", launchTarget()]).ok;
  const result = capture("launchctl", ["bootout", launchTarget()]);
  if (!result.ok && !/Could not find service|No such process|not found/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`停止 LaunchAgent 失败：${summarizeOutput(result.stderr || result.stdout)}`);
  }
  if (wasLoaded) await waitForLaunchAgentStopped(10_000);
}

async function waitForLaunchAgentStopped(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const loaded = capture("launchctl", ["print", launchTarget()]).ok;
    const appPortOpen = await isTcpPortOpen(3000);
    if (!loaded && !appPortOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("旧版远程服务未在 10 秒内完全退出，已停止切换以避免端口冲突。");
}

function isTcpPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function bootstrapLaunchAgent() {
  const bootstrap = capture("launchctl", ["bootstrap", launchDomain(), launchAgentPath]);
  if (!bootstrap.ok && !/already loaded|service already loaded/i.test(`${bootstrap.stdout}\n${bootstrap.stderr}`)) {
    throw new Error(`加载 LaunchAgent 失败：${summarizeOutput(bootstrap.stderr || bootstrap.stdout)}`);
  }
  // RunAtLoad 已随 bootstrap 启动，避免立即再杀掉刚启动的进程。
  if (bootstrap.ok) return;
  const kickstart = capture("launchctl", ["kickstart", "-k", launchTarget()]);
  if (!kickstart.ok) {
    throw new Error(`启动 LaunchAgent 失败：${summarizeOutput(kickstart.stderr || kickstart.stdout)}`);
  }
}

async function assertNoActiveJobs() {
  const result = await fetchJson("http://127.0.0.1:3000/api/jobs", 5_000);
  if (!result.ok) {
    // A refused connection confirms a stopped service; an open or unresponsive port is unsafe to switch.
    if (result.connectionRefused && !await isTcpPortOpen(3000)) return;
    throw new Error(`无法确认任务状态，已停止切换：${result.error || "任务接口不可用"}`);
  }
  const data = result.data;
  if (!Array.isArray(data?.jobs) || !Array.isArray(data.readErrors) ||
      !data.recoveryErrors || typeof data.recoveryErrors !== "object" || Array.isArray(data.recoveryErrors) ||
      data.readErrors.length || Object.keys(data.recoveryErrors).length ||
      data.jobs.some((job) => !job || !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(job.status))) {
    throw new Error("任务记录读取或恢复异常，无法确认完整任务状态，已停止切换，请先检查任务中心。");
  }
  if (data.pendingCreations !== undefined && (!Number.isInteger(data.pendingCreations) || data.pendingCreations < 0 || data.pendingCreations > 0)) {
    throw new Error("任务正在创建或状态无效，已停止切换。");
  }
  if (data.pendingCreations === undefined) console.warn("当前版本尚不支持切换期间暂停接收任务；本次切换仅能核对任务列表，请避免同时提交任务。");
  const active = data.jobs.filter((job) => ["queued", "running"].includes(job.status));
  if (active.length) {
    throw new Error(`当前有 ${active.length} 个运行或排队任务，请等待完成或手动停止后再继续。`);
  }
}

async function waitForHealth(timeoutMs, expectedBuildId) {
  if (!expectedBuildId) throw new Error("缺少预期版本，无法验证服务。");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fetchJson(readyUrl, Math.min(2_500, deadline - Date.now()));
    if (result.ok && result.data?.ready === true && result.data.storage === "ok" &&
        result.data.appMode === "workspace" && result.data.serviceMode === "production" && result.data.buildId === expectedBuildId) return true;
    // 旧版无 ready 接口时仍支持回滚，但不能把错误响应或缺失字段当作健康。
    if (result.status === 404) {
      const legacy = await fetchJson(`${healthUrl}?fresh=1`, Math.max(1, Math.min(10_000, deadline - Date.now())));
      if (legacy.ok && legacy.data?.app?.buildId === expectedBuildId && legacy.data.app.appMode === "workspace" &&
          ["ok", "degraded"].includes(legacy.data.app.status) && legacy.data.services?.storage?.status === "ok") return true;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  return false;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const data = await response.json().catch(() => null);
    return response.ok
      ? { ok: true, data, status: response.status }
      : { ok: false, status: response.status, error: data?.error || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: describeError(error), connectionRefused: error?.cause?.code === "ECONNREFUSED" };
  } finally {
    clearTimeout(timeout);
  }
}

async function currentReleasePath() {
  try {
    return await fs.promises.realpath(currentLink);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function currentReleaseName() {
  const target = await currentReleasePath();
  return target ? path.basename(target) : "";
}

async function readReleaseBuild(releaseRoot) {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(releaseRoot, "REMOTE_BUILD.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function listReleases() {
  await fs.promises.mkdir(releasesRoot, { recursive: true });
  const entries = await fs.promises.readdir(releasesRoot, { withFileTypes: true });
  const releases = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(releasesRoot, entry.name));
  const withStats = await Promise.all(releases.map(async (release) => ({
    release,
    mtimeMs: (await fs.promises.stat(release)).mtimeMs
  })));
  return withStats.sort((left, right) => right.mtimeMs - left.mtimeMs).map((entry) => entry.release);
}

async function pruneReleases(previousRelease) {
  const current = await currentReleasePath();
  const releases = await listReleases();
  const previous = previousRelease !== current && await isHealthyRelease(previousRelease) ? previousRelease : await previousHealthyRelease(current, releases);
  const keep = new Set([current, previous]);
  for (const release of releases) {
    if (!keep.has(release)) await fs.promises.rm(release, { recursive: true, force: true });
  }
}

function makeBuildId(gitCommit, dirty, builtAt) {
  const stamp = builtAt.replace(/\D/g, "").slice(0, 14);
  const digest = crypto
    .createHash("sha256")
    .update(`${gitCommit}:${dirty}:${builtAt}`)
    .digest("hex")
    .slice(0, 8);
  return `${stamp}-${gitCommit}${dirty ? "-dirty" : ""}-${digest}`;
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function launchAgentPlist() {
  const args = [process.execPath, path.join(root, "scripts", "remote-server.mjs"), "serve"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(serviceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path.join(os.homedir(), ".local", "bin"))}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errorLogFile)}</string>
</dict>
</plist>
`;
}

function launchDomain() {
  return `gui/${process.getuid()}`;
}

function launchTarget() {
  return `${launchDomain()}/${serviceLabel}`;
}

function capture(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} ${args.join(" ")} 执行失败：code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

async function runNodeScript(script, args, options = {}) {
  try {
    await run(process.execPath, [script, ...args]);
  } catch (error) {
    if (!options.allowFailure) throw error;
  }
}

async function exists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

function summarizeOutput(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500) || "未知错误";
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function withServiceLock(action) {
  if (process.platform !== "darwin") throw new Error("本机常驻服务当前只支持 macOS。");
  await fs.promises.mkdir(stateRoot, { recursive: true });
  const lock = path.join(stateRoot, "service.lock");
  // macOS shlock 原子获取 PID 锁并识别已退出的持有者，避免并发发布/切换。
  const acquired = capture("/usr/bin/shlock", ["-p", String(process.pid), "-f", lock]);
  if (!acquired.ok) throw new Error("已有服务操作正在执行，或无法获取服务锁；请检查 .remote-server/service.lock。");
  try { return await action(); }
  finally { await fs.promises.rm(lock, { force: true }); }
}

async function timed(label, action) {
  const started = Date.now();
  try { return await action(); }
  finally { console.log(`${label}耗时：${((Date.now() - started) / 1000).toFixed(1)} 秒`); }
}

async function requireHealthy(release) {
  const build = await readReleaseBuild(release);
  if (!build?.buildId || build.buildId !== path.basename(release)) throw new Error("发布元数据缺失或版本不匹配，无法验证服务。");
  if (!await waitForHealth(30_000, build.buildId)) throw new Error(`版本 ${build.buildId} 未通过应用与存储检查，请查看 ${errorLogFile}`);
}

async function reportDependencies(baseline) {
  async function check() {
    const result = await fetchJson(`${healthUrl}?fresh=1`, 15_000);
    if (!result.ok || !result.data?.services) throw new Error(`应用已启动，但运行状态接口验证失败：${result.error || "响应格式无效"}`);
    const regressions = [];
    for (const name of dependencyNames) {
      const service = result.data.services[name];
      if (!service || !["ok", "unconfigured", "unavailable"].includes(service.status)) throw new Error(`外部能力状态缺失：${name}`);
      if (service.status !== "ok") {
        console.warn(`外部能力 ${name}：${service.message || service.status}`);
        // Chrome 生命周期独立于应用版本；离线明确告警，不靠重启应用恢复浏览器。
        if (name !== "browserBridge" && baseline?.services?.[name]?.status === "ok") regressions.push(name);
      }
    }
    return regressions;
  }
  if ((await check()).length) {
    const regressions = await check();
    if (regressions.length) throw new Error(`发布后外部能力持续出现新增异常：${regressions.join("、")}`);
  }
}

async function isHealthyRelease(release) {
  return Boolean(release && (await readReleaseBuild(release))?.buildId === path.basename(release) &&
    await exists(path.join(release, "HEALTHY")) && !await exists(path.join(release, "FAILED")) &&
    await exists(path.join(release, "server.js")));
}

async function previousHealthyRelease(current, releases) {
  for (const release of releases) if (release !== current && await isHealthyRelease(release)) return release;
  return null;
}

async function activateWithRecovery(target, previous, baseline, operation) {
  try {
    await activateRelease(target);
    await switchToProduction();
    await requireHealthy(target);
    await reportDependencies(baseline);
    await fs.promises.rm(path.join(target, "FAILED"), { force: true });
    await fs.promises.writeFile(path.join(target, "HEALTHY"), `${new Date().toISOString()}\n`, "utf8");
  } catch (error) {
    try { await fs.promises.writeFile(path.join(target, "FAILED"), `${describeError(error)}\n`, "utf8"); }
    catch (markerError) { console.error(`失败标记写入失败：${describeError(markerError)}`); }
    if (!previous || previous === target || !await isHealthyRelease(previous)) {
      throw new Error(`${operation}失败：${describeError(error)}；无可验证的上一健康版本，未执行恢复。`);
    }
    try {
      await assertNoActiveJobs();
      await activateRelease(previous);
      await switchToProduction();
      await requireHealthy(previous);
      await reportDependencies(baseline);
    } catch (recoveryError) {
      throw new Error(`${operation}失败：${describeError(error)}；恢复失败：${describeError(recoveryError)}；请查看 ${errorLogFile}`);
    }
    throw new Error(`${operation}失败：${describeError(error)}；已恢复并验证上一版本 ${path.basename(previous)}。`);
  }
}

async function withTaskProtection(action) {
  const gate = path.join(stateRoot, "switching.json");
  await writeJsonAtomic(gate, { pid: process.pid });
  try {
    await assertNoActiveJobs();
    return await action();
  } finally {
    await fs.promises.rm(gate, { force: true });
  }
}
