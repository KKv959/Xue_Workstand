import { readFileSync } from "node:fs";
import path from "node:path";

const state = globalThis as typeof globalThis & { pendingJobCreations?: number };

export function pendingJobCreations() {
  return state.pendingJobCreations || 0;
}

export async function withJobAdmission<T>(create: () => Promise<T>): Promise<T> {
  const gate = path.join(process.env.WORKBENCH_SOURCE_ROOT || process.cwd(), ".remote-server", "switching.json");
  try {
    const { pid } = JSON.parse(readFileSync(gate, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("服务切换记录损坏，请检查本机服务状态。");
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      // 切换进程已退出，不让遗留标记阻塞任务。
      return admit(create);
    }
    throw Object.assign(new Error("服务正在切换，请稍后重新提交任务。"), { status: 409 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return admit(create);
}

async function admit<T>(create: () => Promise<T>): Promise<T> {
  // 同步检查入口并计数；切换检查也能看到尚未落盘的创建请求。
  state.pendingJobCreations = pendingJobCreations() + 1;
  try { return await create(); }
  finally { state.pendingJobCreations = pendingJobCreations() - 1; }
}
