import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { libraryRoot } from "@/lib/storage";
import { getChatRuntimeConfig } from "@/lib/ai";
import { getImageRuntimeConfig } from "@/lib/image-runtime";
import { getPiStatus } from "@/lib/pi-runtime";
import { checkFeishuRuntime } from "@/lib/feishu";
import { probeChatModel } from "@/lib/model-runtime";
import { resolveOpenCliCommand } from "@/lib/opencli";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const HIDDEN_CHILD_PROCESS_OPTIONS = { windowsHide: true };

export async function GET(request: Request) {
  const runtime = resolveOpenCliCommand();
  const opencli = runtime.command;
  let opencliOk = false;
  let opencliVersion = "";
  let opencliError = "";
  try {
    const { stdout } = await execFileAsync(opencli, [...runtime.argsPrefix, "--version"], {
      ...HIDDEN_CHILD_PROCESS_OPTIONS,
      timeout: 5000
    });
    opencliOk = true;
    opencliVersion = stdout.trim();
  } catch (error) {
    opencliOk = false;
    opencliError = error instanceof Error ? error.message : "opencli 不可用";
  }

  if (process.env.APP_MODE === "gross-margin") {
    const storage = await checkGrossMarginStorage();
    const ready = opencliOk && storage.ok;
    return NextResponse.json({
      appMode: "gross-margin",
      opencli: {
        ok: opencliOk,
        version: opencliVersion,
        error: opencliError
      },
      storage
    }, {
      status: ready ? 200 : 503
    });
  }

  const chat = getChatRuntimeConfig();
  const image = getImageRuntimeConfig();
  const [chatProbe, feishu, pi] = await Promise.all([
    probeChatModel({ signal: request.signal }),
    checkFeishuRuntime(),
    getPiStatus()
  ]);

  return NextResponse.json({
    opencli: {
      ok: opencliOk,
      bin: opencli,
      version: opencliVersion
    },
    libraryRoot: libraryRoot(),
    volcengineAsrConfigured: Boolean(
      process.env.VOLCENGINE_ASR_API_KEY ||
      process.env.VOLCENGINE_API_KEY ||
      (process.env.VOLCENGINE_ASR_APP_KEY && process.env.VOLCENGINE_ASR_ACCESS_KEY)
    ),
    chatConfigured: pi.configured || chat.configured,
    pi,
    chatReachable: chatProbe.ok,
    chat,
    chatProbe,
    imageConfigured: image.configured,
    image,
    feishuConfigured: feishu.configured,
    feishu,
  });
}

async function checkGrossMarginStorage() {
  const root = path.join(libraryRoot(), "gross-margin");
  const probe = path.join(root, ".healthcheck");
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(probe, `${Date.now()}`, "utf8");
    await fs.rm(probe, { force: true });
    return { ok: true, root };
  } catch (error) {
    return {
      ok: false,
      root,
      error: error instanceof Error ? error.message : "毛利数据目录不可写"
    };
  }
}
