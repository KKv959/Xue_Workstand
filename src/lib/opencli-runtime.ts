import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const HIDDEN_CHILD_PROCESS_OPTIONS = { windowsHide: true };
const OPENCLI_BROWSER_CONNECT_RETRY_DELAY_MS = 1_200;
const DEFAULT_SHARED_BROWSER_SESSION = "content-workbench-browser";
// Chrome 只要还有标签页挂着调试器就常驻“已开始调试此浏览器”提示条，
// 共享会话空闲一会儿就释放；释放后标签页留作空白占位，复用同一窗口和分组。
const SHARED_BROWSER_SESSION_IDLE_RELEASE_MS = 30_000;

type OpenCliQueue = Promise<unknown>;

// Next.js 路由模块和热更新可能加载多个模块实例，但共用同一个浏览器标签页。
// 队列必须与 jobs runtime 一样存于进程全局，避免详情补全导航打断历史采集。
const globalOpenCli = globalThis as typeof globalThis & {
  __styleWorkbenchOpenCliQueues?: Map<string, OpenCliQueue>;
  __styleWorkbenchOpenCliReleaseTimers?: Map<string, ReturnType<typeof setTimeout>>;
};
const browserOperationQueues = globalOpenCli.__styleWorkbenchOpenCliQueues ||= new Map<string, OpenCliQueue>();
const sharedSessionReleaseTimers = globalOpenCli.__styleWorkbenchOpenCliReleaseTimers ||= new Map<string, ReturnType<typeof setTimeout>>();

type OpenCliBrowserWindowMode = "foreground" | "background";

export type OpenCliTimingMeta = Record<string, string | number | boolean | null | undefined>;
export type OpenCliTimingEntry = {
  stage: string;
  ms: number;
  ok: boolean;
  meta?: OpenCliTimingMeta;
  error?: string;
};
export type OpenCliTimingSink = (entry: OpenCliTimingEntry) => void;

export type OpenCliTimingOptions = {
  timingMeta?: OpenCliTimingMeta;
  onTiming?: OpenCliTimingSink;
  signal?: AbortSignal;
};

export type RunOpenCliOptions = OpenCliTimingOptions & {
  timeout?: number;
  timingStage?: string;
};

export type SharedOpenCliBrowserOptions = {
  signal?: AbortSignal;
  session?: string;
};

export function opencliBin() {
  return process.env.OPENCLI_BIN || "opencli";
}

export function resolveOpenCliCommand() {
  const configured = opencliBin().trim() || "opencli";
  const scriptPath = process.env.OPENCLI_SCRIPT?.trim() || "";
  const nodeBin = process.env.OPENCLI_NODE_BIN?.trim() || process.execPath;
  const profile = process.env.OPENCLI_PROFILE?.trim() || "";
  const profileArgs = profile ? ["--profile", profile] : [];

  if (scriptPath) {
    return {
      command: nodeBin,
      argsPrefix: [scriptPath, ...profileArgs]
    };
  }

  return {
    command: configured,
    argsPrefix: profileArgs
  };
}

export async function runOpenCli(args: string[], options: RunOpenCliOptions = {}) {
  let stdout = "";
  let stderr = "";
  const runtime = resolveOpenCliCommand();
  const startedAt = Date.now();
  let timingRecorded = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await execFileAsync(runtime.command, [...runtime.argsPrefix, ...args], {
        ...HIDDEN_CHILD_PROCESS_OPTIONS,
        env: withOpenCliBackgroundWindow(process.env),
        maxBuffer: 1024 * 1024 * 20,
        timeout: options.timeout,
        signal: options.signal
      });
      stdout = unwrapOpenCliOutput(result.stdout);
      stderr = result.stderr;
      break;
    } catch (error) {
      if (attempt === 0 && isOpenCliBrowserConnectError(error) && !options.signal?.aborted) {
        await waitForOpenCliRetry(OPENCLI_BROWSER_CONNECT_RETRY_DELAY_MS, options.signal);
        continue;
      }
      if (attempt === 0 && isOpenCliJavaScriptDialogError(error) && !options.signal?.aborted) {
        await dismissOpenCliJavaScriptDialog(runtime, args, options).catch(() => undefined);
        continue;
      }
      recordTiming(options, startedAt, false, undefined, error);
      throw wrapOpenCliError(error);
    }
  }

  if (stderr && stderr.toLowerCase().includes("error")) {
    const error = new Error(stderr.trim());
    recordTiming(options, startedAt, false, undefined, error);
    timingRecorded = true;
    throw error;
  }

  if (!timingRecorded) recordTiming(options, startedAt, true);
  return stdout.trim();
}

// OpenCLI 2 returns an envelope; keep existing callers on the payload contract.
export function unwrapOpenCliOutput(stdout: string): string {
  let payload: unknown;
  try { payload = JSON.parse(stdout); } catch { return stdout; }
  if (!payload || typeof payload !== "object") return stdout;
  const envelope = payload as Record<string, unknown>;
  if (envelope.ok === false && "error" in envelope) {
    throw new Error(`OpenCLI 执行失败：${JSON.stringify(envelope.error)}`);
  }
  if (envelope.ok === true && "data" in envelope) {
    return JSON.stringify(envelope.data) ?? "null";
  }
  return stdout;
}

export function sharedOpenCliBrowserSession() {
  return process.env.OPENCLI_BROWSER_SESSION?.trim() || DEFAULT_SHARED_BROWSER_SESSION;
}

export function withSharedOpenCliBrowserSession<T>(
  operation: (session: string) => Promise<T>,
  options: SharedOpenCliBrowserOptions = {}
) {
  // Serialize one leased background tab per session and release it once idle,
  // so the debugger detaches between bursts instead of staying attached forever.
  const session = options.session || sharedOpenCliBrowserSession();
  const key = `browser:${session}`;
  cancelSharedSessionRelease(key);
  const result = enqueueOpenCliBrowserOperation(key, () => operation(session), options.signal);
  const scheduleRelease = () => scheduleSharedSessionRelease(key, session);
  void result.then(scheduleRelease, scheduleRelease);
  return result;
}

function cancelSharedSessionRelease(key: string) {
  const timer = sharedSessionReleaseTimers.get(key);
  if (timer) clearTimeout(timer);
  sharedSessionReleaseTimers.delete(key);
}

function scheduleSharedSessionRelease(key: string, session: string) {
  cancelSharedSessionRelease(key);
  const timer = setTimeout(() => {
    sharedSessionReleaseTimers.delete(key);
    // A newer operation is queued or running; it schedules its own release.
    if (browserOperationQueues.has(key)) return;
    void enqueueOpenCliBrowserOperation(key, () => runOpenCli(buildOpenCliBrowserArgs(session, "close"), { timeout: 5_000 }))
      // Release is best-effort cleanup: the next operation reopens the session,
      // and the extension's own idle timeout reclaims the lease if this fails.
      .catch(() => undefined);
  }, SHARED_BROWSER_SESSION_IDLE_RELEASE_MS);
  timer.unref?.();
  sharedSessionReleaseTimers.set(key, timer);
}

// Only use for browser reads: a detached tab can interrupt an in-flight eval,
// so callers must be safe to repeat after reopening the session.
export async function retryDetachedBrowserRead<T>(
  read: () => Promise<T>,
  reconnect: () => Promise<void>,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (signal?.aborted || !/Detached while handling command/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    await waitForOpenCliRetry(OPENCLI_BROWSER_CONNECT_RETRY_DELAY_MS, signal);
    await reconnect();
    if (signal?.aborted) throw createAbortError();
    return read();
  }
}

export function runPersistentOpenCliBrowserAdapter(args: string[], options: RunOpenCliOptions = {}) {
  const site = args[0]?.trim();
  if (!site || site === "browser") {
    throw new Error("OpenCLI 持久浏览器适配器缺少有效站点名称");
  }
  const adapterArgs = withBackgroundBrowserAdapterOptions(args);
  // Persistent site sessions never release their tab, which keeps Chrome's
  // debugging banner up even when idle. One-shot tabs detach after each run and
  // reuse the automation window; serialize them per site to keep one live tab.
  return enqueueOpenCliBrowserOperation(
    `adapter:${site}`,
    () => runOpenCli(adapterArgs, options),
    options.signal
  );
}

export function withBackgroundBrowserAdapterOptions(args: string[]) {
  const normalized = [...args];
  if (!normalized.includes("--window")) normalized.push("--window", "background");
  if (!normalized.includes("--site-session")) normalized.push("--site-session", "ephemeral");
  return normalized;
}

export async function timeOpenCliOperation<T>(
  options: OpenCliTimingOptions | undefined,
  stage: string,
  operation: () => Promise<T>,
  meta?: OpenCliTimingMeta
) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    options?.onTiming?.(makeTimingEntry(stage, Date.now() - startedAt, true, mergeTimingMeta(options.timingMeta, meta)));
    return result;
  } catch (error) {
    options?.onTiming?.(makeTimingEntry(stage, Date.now() - startedAt, false, mergeTimingMeta(options?.timingMeta, meta), error));
    throw error;
  }
}

export function mergeTimingMeta(...metas: Array<OpenCliTimingMeta | undefined>) {
  const merged: OpenCliTimingMeta = {};
  for (const meta of metas) {
    if (!meta) continue;
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

export function withTimingMeta(options: OpenCliTimingOptions | undefined, meta: OpenCliTimingMeta): OpenCliTimingOptions {
  return {
    onTiming: options?.onTiming,
    timingMeta: mergeTimingMeta(options?.timingMeta, meta),
    signal: options?.signal
  };
}

export function buildOpenCliBrowserArgs(
  session: string,
  command: string,
  commandArgs: string[] = [],
  options: {
    tab?: string;
    window?: OpenCliBrowserWindowMode;
  } = {}
) {
  const args = ["browser", "--session", session];
  if (options.window) {
    args.push("--window", options.window);
  }
  args.push(command);
  if (options.tab) {
    args.push("--tab", options.tab);
  }
  args.push(...commandArgs);
  return args;
}

export function parseOpenCliJsonish(stdout: string): unknown {
  return parseJsonish(stdout);
}

export function openCliRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const object = raw as Record<string, unknown>;
    for (const key of ["data", "items", "results", "videos", "list", "users", "user_list"]) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }
  }
  throw new Error("OpenCLI 返回了无法解析的列表数据，请检查平台会话或 CLI 版本。");
}

export function parseJsonish(stdout: string): unknown {
  if (!stdout) return [];
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

export function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const object = raw as Record<string, unknown>;
    for (const key of ["data", "items", "results", "videos", "list", "users", "user_list"]) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }
  }
  return [];
}

export function stringField(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function recordTiming(
  options: RunOpenCliOptions,
  startedAt: number,
  ok: boolean,
  meta?: OpenCliTimingMeta,
  error?: unknown
) {
  if (!options.timingStage || !options.onTiming) return;
  options.onTiming(makeTimingEntry(options.timingStage, Date.now() - startedAt, ok, mergeTimingMeta(options.timingMeta, meta), error));
}

function makeTimingEntry(
  stage: string,
  ms: number,
  ok: boolean,
  meta?: OpenCliTimingMeta,
  error?: unknown
): OpenCliTimingEntry {
  const entry: OpenCliTimingEntry = {
    stage,
    ms,
    ok
  };
  const cleanMeta = compactTimingMeta(meta);
  if (cleanMeta) entry.meta = cleanMeta;
  const message = formatTimingError(error);
  if (message) entry.error = message;
  return entry;
}

function compactTimingMeta(meta: OpenCliTimingMeta | undefined) {
  if (!meta) return undefined;
  const clean: OpenCliTimingMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : undefined;
}

function formatTimingError(error: unknown) {
  if (!error) return "";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
}

export function wrapOpenCliError(error: unknown) {
  if (isMissingExecutableError(error)) {
    return new Error("未检测到 opencli。数据维护 / 数据监控页面可以继续使用，但实时刷新 B站/抖音数据前请先运行 install-deps.cmd 安装 opencli。");
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return error;
    const failure = error as Error & { stderr?: string; stdout?: string; killed?: boolean; signal?: string };
    const detail = String(failure.stderr || failure.stdout || "").trim();
    if (detail) {
      const reason = /execution context.*destroyed|cannot find context|inspected target.*navigated/i.test(detail)
        ? "采集使用的浏览器页面被跳转或重载，请重试采集。"
        : detail.replace(/\s+/g, " ").slice(0, 1500);
      return new Error(`OpenCLI 执行失败：${reason}`, { cause: error });
    }
    if (failure.killed) return new Error("OpenCLI 请求超时或进程被终止，请重试或缩小采集范围。", { cause: error });
    return error;
  }
  return new Error("opencli 执行失败");
}

function enqueueOpenCliBrowserOperation<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal) {
  const previous = browserOperationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    if (signal?.aborted) throw createAbortError();
    return operation();
  });
  const settled = current.then(() => undefined, () => undefined);
  browserOperationQueues.set(key, settled);
  void settled.finally(() => {
    if (browserOperationQueues.get(key) === settled) browserOperationQueues.delete(key);
  });
  return current;
}

function withOpenCliBackgroundWindow(env: NodeJS.ProcessEnv) {
  if (env.OPENCLI_WINDOW?.trim()) return env;
  return { ...env, OPENCLI_WINDOW: "background" };
}

async function dismissOpenCliJavaScriptDialog(
  runtime: ReturnType<typeof resolveOpenCliCommand>,
  args: string[],
  options: RunOpenCliOptions
) {
  const session = getOpenCliBrowserSessionArg(args);
  if (!session) return;
  await execFileAsync(runtime.command, [...runtime.argsPrefix, ...buildOpenCliBrowserArgs(session, "dialog", ["dismiss"])], {
    ...HIDDEN_CHILD_PROCESS_OPTIONS,
    env: withOpenCliBackgroundWindow(process.env),
    maxBuffer: 1024 * 1024,
    timeout: Math.min(options.timeout || 10_000, 10_000),
    signal: options.signal
  });
}

function getOpenCliBrowserSessionArg(args: string[]) {
  const index = args.indexOf("--session");
  return args[0] === "browser" && index >= 0 ? args[index + 1]?.trim() || "" : "";
}

function isOpenCliJavaScriptDialogError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr || "") : "";
  const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout || "") : "";
  return /javascript_dialog_open|javascript dialog|dialog is open|modal.*open/i.test(`${message}\n${stderr}\n${stdout}`);
}

function isMissingExecutableError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return code === "ENOENT" || /not found|enoent/i.test(message);
}

function isOpenCliBrowserConnectError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr || "") : "";
  return /BROWSER_CONNECT|browser profile .*not connected|extension .*not connected/i.test(`${message}\n${stderr}`);
}

function waitForOpenCliRetry(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createAbortError() {
  const error = new Error("任务已停止");
  error.name = "AbortError";
  return error;
}
