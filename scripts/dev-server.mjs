import fs from "fs";
import net from "net";
import path from "path";
import process from "process";
import { spawn } from "child_process";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const stateDir = path.join(root, ".dev-server");
const pidFile = path.join(stateDir, "next-dev.pid");
const logFile = path.join(stateDir, "next-dev.log");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const command = process.argv[2] || "start";

async function main() {
  await fs.promises.mkdir(stateDir, { recursive: true });

  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "restart") {
    await stop({ quiet: true });
    return start();
  }
  if (command === "status") return status();
  if (command === "serve") return serve();

  console.error("用法：node scripts/dev-server.mjs <start|stop|restart|status>");
  process.exit(1);
}

async function start() {
  const current = readPid();
  if (current && isRunning(current)) {
    console.log(`Next dev 已在运行：pid=${current}, http://localhost:${port}`);
    return;
  }

  const listener = await findPortListener(port);
  if (listener) {
    console.error(`端口 ${port} 已被占用：pid=${listener.pid || "unknown"} ${listener.command || ""}`.trim());
    process.exit(1);
  }

  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, HOST: host, PORT: String(port) }
  });

  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  fs.closeSync(logFd);

  const earlyExit = await waitForEarlyExit(child, 2500);
  if (earlyExit) {
    fs.rmSync(pidFile, { force: true });
    console.error(`Next dev 启动失败：子进程过早退出 code=${earlyExit.code ?? "null"} signal=${earlyExit.signal ?? "null"}`);
    const logTail = readLogTail(logFile);
    if (logTail) {
      console.error("\n最近日志：");
      console.error(logTail.trimEnd());
    }
    if (logTail.includes("listen EPERM")) {
      console.error(
        `\n检测到 listen EPERM：当前执行环境没有权限监听 ${host}:${port}。请在普通 Terminal 里运行 npm run dev:daemon，或给当前工具授予本地端口监听权限。`
      );
    }
    process.exit(1);
  }

  child.unref();
  console.log(`已后台启动 Next dev：pid=${child.pid}`);
  console.log(`地址：http://${host}:${port}`);
  console.log(`日志：${logFile}`);
}

async function serve() {
  const child = spawn("npm", ["run", "dev", "--", "--hostname", host], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env, HOST: host, PORT: String(port)
    }
  });
  const shutdown = () => child.kill("SIGTERM");
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const finish = (code) => {
    process.exitCode = code;
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  };
  child.once("error", () => {
    console.error("开发服务启动失败：无法启动 npm，请检查 Node.js 安装与 PATH。");
    finish(1);
  });
  child.once("exit", (code, signal) => finish(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1)));
}

async function stop(options = {}) {
  const pid = readPid();
  if (!pid) {
    const listener = await findPortListener(port);
    if (!listener?.pid) {
      if (!options.quiet) console.log("没有找到后台 dev server pid。");
      return;
    }

    const listenerCwd = await findProcessCwd(listener.pid);
    if (listenerCwd !== root) {
      if (!options.quiet) {
        console.log(`没有找到后台 dev server pid，端口 ${port} 被其他目录占用：pid=${listener.pid} ${listener.command || ""}`.trim());
      }
      return;
    }

    if (!options.quiet) {
      console.log(`没有 pid 文件，但端口 ${port} 上有本项目旧 dev server：pid=${listener.pid}，尝试停止。`);
    }
    await stopPid(listener.pid, options);
    return;
  }

  if (!isRunning(pid)) {
    fs.rmSync(pidFile, { force: true });
    if (!options.quiet) console.log(`后台 dev server 已不在运行，已清理 pid：${pid}`);
    return;
  }

  await stopPid(pid, options);
}

async function stopPid(pid, options = {}) {
  const signaled = signalDevServer(pid, "SIGTERM");
  if (!signaled) {
    if (!options.quiet) console.log(`无法停止后台 dev server：pid=${pid}，当前进程没有权限发送 SIGTERM。`);
    return;
  }

  const stopped = await waitForStop(pid, 5000);
  if (!stopped) {
    const killed = signalDevServer(pid, "SIGKILL");
    if (!killed && !options.quiet) {
      console.log(`后台 dev server 未退出，且当前进程没有权限发送 SIGKILL：pid=${pid}。`);
    }
  }
  fs.rmSync(pidFile, { force: true });
  if (!options.quiet) console.log(`已停止后台 dev server：pid=${pid}`);
}

async function status() {
  const pid = readPid();
  const listener = await findPortListener(port);
  const healthy = await canConnect(port);

  console.log(
    JSON.stringify(
      {
        pid,
        pidRunning: pid ? isRunning(pid) : false,
        port,
        portListening: Boolean(listener),
        listener,
        healthy,
        url: `http://${host}:${port}`,
        logFile
      },
      null,
      2
    )
  );
}

function readPid() {
  try {
    const value = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalDevServer(pid, signal) {
  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function waitForEarlyExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.off("exit", onExit);
    }

    function onExit(code, signal) {
      cleanup();
      resolve({ code, signal });
    }

    child.once("exit", onExit);
  });
}

async function waitForStop(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const listener = await findPortListener(port);
    if (!isRunning(pid) && !listener) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function readLogTail(targetFile, maxBytes = 6000) {
  try {
    const fd = fs.openSync(targetFile, "r");
    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function canConnect(targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function findPortListener(targetPort) {
  const result = await run("lsof", ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN", "-FpPc"]).catch(() => "");
  const lines = result.split("\n").filter(Boolean);
  if (!lines.length) return null;

  const info = {};
  for (const line of lines) {
    const prefix = line[0];
    const value = line.slice(1);
    if (prefix === "p") info.pid = Number(value);
    if (prefix === "c") info.command = value;
  }
  return Object.keys(info).length ? info : { port: targetPort };
}

async function findProcessCwd(pid) {
  if (!pid) return "";
  const result = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).catch(() => "");
  return result
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1) || "";
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `${bin} exited with ${code}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
