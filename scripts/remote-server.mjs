import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import process from "process";

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
const sourceEntries = [
  "src",
  "public",
  "middleware.ts",
  "eslint.config.mjs",
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  "tsconfig.json",
  "next-env.d.ts"
];

try {
  await main();
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
  if (command === "deploy") return deploy();
  if (command === "rollback") return rollback();
  if (command === "serve") return serve();

  throw new Error("用法：node scripts/remote-server.mjs <setup|start|stop|status|dev|deploy|rollback>");
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
  if (!(await exists(path.join(currentLink, "server.js")))) {
    throw new Error("尚无可运行版本，请先执行 npm run remote:deploy。");
  }
  if (!(await exists(launchAgentPath))) {
    throw new Error("尚未安装 LaunchAgent，请先执行 npm run remote:setup。");
  }

  await assertNoActiveJobs();

  await fs.promises.mkdir(stateRoot, { recursive: true });
  await runNodeScript(devScript, ["stop"], { allowFailure: true });
  await stopLaunchAgent();
  await bootstrapLaunchAgent();

  const healthy = await waitForHealth(30_000);
  if (!healthy) {
    throw new Error(`正式服务启动失败，请查看日志：${errorLogFile}`);
  }
  console.log("远程正式服务已启动：http://127.0.0.1:3000");
}

async function stop() {
  await stopLaunchAgent();
  console.log("远程正式服务已停止。");
}

async function startDevelopment() {
  await assertNoActiveJobs();
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

async function deploy() {
  if (!(await exists(launchAgentPath))) {
    throw new Error("尚未完成远程环境配置，请先执行 npm run remote:setup。");
  }
  await assertNoActiveJobs();
  const build = await buildRelease();
  await assertNoActiveJobs();
  const previousRelease = await currentReleasePath();

  try {
    await activateRelease(build.releaseRoot);
    await switchToProduction();
    if (!(await waitForHealth(30_000, build.buildId))) {
      throw new Error("新版本启动后未在 30 秒内通过健康检查。");
    }
    await fs.promises.writeFile(path.join(build.releaseRoot, "HEALTHY"), `${new Date().toISOString()}\n`, "utf8");
    await pruneReleases(2);
    console.log(`发布成功：${build.buildId}`);
    console.log("手机重新打开或点击版本提示即可使用新版本。");
  } catch (error) {
    if (previousRelease && await exists(path.join(previousRelease, "server.js"))) {
      console.error(`发布失败，正在恢复上一版本：${path.basename(previousRelease)}`);
      await activateRelease(previousRelease);
      await switchToProduction();
      if (!(await waitForHealth(30_000))) {
        throw new Error(`${describeError(error)}；上一版本恢复后仍未通过健康检查，请查看 ${errorLogFile}`);
      }
    }
    throw error;
  }
}

async function rollback() {
  await assertNoActiveJobs();
  const current = await currentReleasePath();
  const releases = await listReleases();
  const target = releases.find((release) => release !== current && fs.existsSync(path.join(release, "HEALTHY")));
  if (!target) throw new Error("没有可回退的历史版本。");

  await activateRelease(target);
  try {
    await switchToProduction();
    const build = await readReleaseBuild(target);
    if (!(await waitForHealth(30_000, build?.buildId))) {
      throw new Error("回退版本未通过健康检查。");
    }
    console.log(`已回退到：${path.basename(target)}`);
  } catch (error) {
    if (current) {
      await activateRelease(current);
      await switchToProduction();
      const build = current ? await readReleaseBuild(current) : null;
      await waitForHealth(30_000, build?.buildId);
    }
    throw error;
  }
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

async function buildRelease() {
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
      if (await exists(source)) {
        await fs.promises.cp(source, path.join(stagingRoot, entry), { recursive: true });
      }
    }

    console.log(`准备构建：${buildId}`);
    await run("npm", ["ci", "--include=dev"], { cwd: stagingRoot });
    await run("npm", ["run", "lint"], { cwd: stagingRoot });
    await run("npm", ["run", "typecheck"], { cwd: stagingRoot });
    await run("npm", ["run", "check:library"], {
      cwd: root,
      env: { ...process.env, STYLE_LIBRARY_DIR: path.join(root, "style-library") }
    });
    await run("npm", ["run", "build"], {
      cwd: stagingRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        APP_MODE: "workspace",
        APP_START_PATH: "/douyin-hotlist",
        APP_BUILD_ID: buildId,
        APP_STARTED_AT: builtAt
      }
    });

    const standaloneRoot = path.join(stagingRoot, ".next", "standalone");
    if (!(await exists(path.join(standaloneRoot, "server.js")))) {
      throw new Error("构建完成但没有生成 .next/standalone/server.js。");
    }

    await fs.promises.rm(releaseRoot, { recursive: true, force: true });
    await fs.promises.mkdir(releaseRoot, { recursive: true });
    await fs.promises.cp(standaloneRoot, releaseRoot, { recursive: true });
    await fs.promises.mkdir(path.join(releaseRoot, ".next"), { recursive: true });
    await fs.promises.cp(
      path.join(stagingRoot, ".next", "static"),
      path.join(releaseRoot, ".next", "static"),
      { recursive: true }
    );
    if (await exists(path.join(stagingRoot, "public"))) {
      await fs.promises.cp(path.join(stagingRoot, "public"), path.join(releaseRoot, "public"), { recursive: true });
    }
    await fs.promises.writeFile(path.join(releaseRoot, "REMOTE_BUILD.json"), JSON.stringify({
      buildId,
      version: readPackageVersion(),
      gitCommit,
      dirty,
      builtAt
    }, null, 2), "utf8");

    return { buildId, releaseRoot };
  } finally {
    await fs.promises.rm(workRoot, { recursive: true, force: true });
  }
}

async function switchToProduction() {
  await runNodeScript(devScript, ["stop"], { allowFailure: true });
  await stopLaunchAgent();
  if (!(await exists(launchAgentPath))) {
    await fs.promises.mkdir(path.dirname(launchAgentPath), { recursive: true });
    await fs.promises.writeFile(launchAgentPath, launchAgentPlist(), "utf8");
  }
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
    console.warn(`停止 LaunchAgent 时收到提示：${summarizeOutput(result.stderr || result.stdout)}`);
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
  const active = data.jobs.filter((job) => ["queued", "running"].includes(job.status));
  if (active.length) {
    throw new Error(`当前有 ${active.length} 个运行或排队任务，请等待完成或手动停止后再继续。`);
  }
}

async function waitForHealth(timeoutMs, expectedBuildId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await fetchJson(healthUrl, 2_500);
    const app = result.data?.app;
    const buildMatches = !expectedBuildId || app?.buildId === expectedBuildId;
    const modeMatches = app?.appMode === "workspace";
    const serviceHealthy = app?.status !== "degraded";
    const storageHealthy = result.data?.services?.storage?.status !== "unavailable";
    if (result.ok && buildMatches && modeMatches && serviceHealthy && storageHealthy) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
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
      ? { ok: true, data }
      : { ok: false, error: data?.error || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: describeError(error), connectionRefused: error?.cause?.code === "ECONNREFUSED" };
  } finally {
    clearTimeout(timeout);
  }
}

async function currentReleasePath() {
  try {
    return await fs.promises.realpath(currentLink);
  } catch {
    return "";
  }
}

async function currentReleaseName() {
  const target = await currentReleasePath();
  return target ? path.basename(target) : "";
}

async function readReleaseBuild(releaseRoot) {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(releaseRoot, "REMOTE_BUILD.json"), "utf8"));
  } catch {
    return null;
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

async function pruneReleases(limit) {
  const current = await currentReleasePath();
  const releases = await listReleases();
  const keep = new Set(
    [current, ...releases.filter((release) => release !== current)]
      .filter(Boolean)
      .slice(0, limit)
  );
  for (const release of releases) {
    if (!keep.has(release)) {
      await fs.promises.rm(release, { recursive: true, force: true });
    }
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
