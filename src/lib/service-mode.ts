import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ServiceMode, ServiceModeStatus } from "./types";
import { writeTextFileAtomic } from "./storage/fs";
import { withMutationLock } from "./storage/mutation-lock";

const exec = promisify(execFile);
const label = "com.xjx.account-style-library.mode-switch";
const globalQueues = globalThis as typeof globalThis & { serviceModeQueues?: Map<string, Promise<unknown>> };
const queues = globalQueues.serviceModeQueues ??= new Map();

export function isLocalServiceRequest(request: Request) {
  const url = new URL(request.url);
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.port === "3000" &&
    (request.method === "GET" || request.headers.get("origin") === url.origin) &&
    !request.headers.has("x-workspace-app-mode");
}

export function serviceModeCommand(root: string, mode: ServiceMode) {
  return ["/usr/bin/env", `WORKBENCH_SOURCE_ROOT=${root}`, `PATH=${process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"}`, process.execPath,
    path.join(root, "scripts", "remote-server.mjs"), mode === "development" ? "dev" : "start"];
}

export function serviceModePlist(root: string, mode: ServiceMode) {
  const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const log = xml(path.join(root, ".remote-server", "mode-switch.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${serviceModeCommand(root, mode).map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>`;
}

async function controlRoot() {
  if (process.platform !== "darwin" || process.env.WORKSPACE_DEV_SANDBOX === "1") return null;
  const root = process.env.WORKBENCH_SOURCE_ROOT || process.cwd();
  try {
    await fs.access(path.join(root, "scripts", "remote-server.mjs"));
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("无法读取服务切换脚本，请检查项目目录权限。");
  }
}

export async function getServiceModeStatus(request: Request): Promise<ServiceModeStatus> {
  const mode = process.env.NODE_ENV === "development" ? "development" : "production";
  if (!isLocalServiceRequest(request)) return { mode, available: false, reason: "请在 Mac 本机的 localhost 页面切换服务。" };
  const root = await controlRoot();
  if (!root) return { mode, available: false, reason: "仅本机 macOS 工作区支持切换服务，隔离测试和云端不可切换。" };
  let stdout: string;
  try {
    ({ stdout } = await exec("/bin/launchctl", ["list"], { timeout: 5000 }));
  } catch {
    throw new Error("无法读取 macOS 服务状态，请检查本机服务权限。");
  }
  const row = stdout.split("\n").find(line => line.trim().endsWith(`\t${label}`));
  const [pid, exitCode] = row?.trim().split(/\s+/) || [];
  let error: string | undefined;
  if (row && pid === "-" && exitCode !== "0") {
    let log: string;
    try { log = await fs.readFile(path.join(root, ".remote-server", "mode-switch.log"), "utf8"); }
    catch { throw new Error("服务切换失败，且无法读取服务日志，请检查项目目录权限。"); }
    error = log.split("\n").filter(line => line.startsWith("远程服务错误：")).at(-1) || "服务切换失败，请检查 Mac 的服务日志。";
  }
  return { mode, available: true, switching: Boolean(row && pid !== "-"), error };
}

export async function switchServiceMode(request: Request, mode: ServiceMode) {
  return withMutationLock(queues, label, async () => {
    const status = await getServiceModeStatus(request);
    if (!status.available) throw Object.assign(new Error(status.reason), { status: 403 });
    if (status.switching) throw Object.assign(new Error("正在切换服务，请等待完成后再试。"), { status: 409 });
    if (status.mode === mode) return { accepted: false };
    const root = (await controlRoot())!;
    // 系统托管短暂的服务切换；不能由即将被停止的 Next.js 进程托管。
    const listed = await exec("/bin/launchctl", ["list"], { timeout: 5000 });
    const previous = listed.stdout.split("\n").find(line => line.trim().endsWith(`\t${label}`));
    if (previous && previous.trim().split(/\s+/)[0] !== "-") {
      throw Object.assign(new Error("正在切换服务，请等待完成后再试。"), { status: 409 });
    }
    if (previous) {
      await exec("/bin/launchctl", ["remove", label], { timeout: 5000 });
    }
    try {
      const plist = path.join(root, ".remote-server", "mode-switch.plist");
      await writeTextFileAtomic(plist, serviceModePlist(root, mode));
      await exec("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist], { timeout: 5000 });
    } catch (error) {
      throw new Error(`无法启动服务切换：${error instanceof Error ? error.message : "请检查 macOS 服务权限"}`);
    }
    return { accepted: true };
  });
}
