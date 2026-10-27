import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { spawn } from "child_process";

const root = process.cwd();
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const preset = readOption("--preset") || "portable";
const includeLibrary = args.has("--include-library");
const allowEmptyGrossMargin = args.has("--allow-empty-gross-margin");
const skipInstall = args.has("--skip-install");
const skipArchive = args.has("--skip-archive");
const skipZip = args.has("--skip-zip");
const skipInstallerCompile = args.has("--skip-installer-compile");
const keepWork = args.has("--keep-work");
const packageJson = JSON.parse(await fs.promises.readFile(path.join(root, "package.json"), "utf8"));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const releaseSuffix = isGrossMarginWindowsPreset(preset) ? preset : "portable";
const releaseName = `${packageJson.name || "account-style-library"}-${packageJson.version || "0.0.0"}-${releaseSuffix}-${stamp}`;
const workRoot = path.join(os.tmpdir(), `${packageJson.name || "account-style-library"}-package-work-${process.pid}`);
const stagingRoot = path.join(workRoot, "source");
const releaseRoot = path.join(root, "dist", releaseName);
const tgzArchivePath = `${releaseRoot}.tar.gz`;
const zipArchivePath = `${releaseRoot}.zip`;
const installerScriptPath = path.join(root, "dist", `${releaseName}.iss`);
const installerOutputPath = path.join(root, "dist", `${releaseName}-setup.exe`);
const presetConfig = getPresetConfig(preset);
const bundledOpenCliVersion = "2.0.1";
const openCliExtensionStoreUrl = "https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk";
const openCliExtensionReleaseUrl = "https://github.com/jackwener/opencli/releases";

try {
  await main();
} finally {
  if (!keepWork) await fs.promises.rm(workRoot, { recursive: true, force: true });
}

async function main() {
  console.log("准备发布工作区...");
  await fs.promises.rm(workRoot, { recursive: true, force: true });
  await fs.promises.rm(releaseRoot, { recursive: true, force: true });
  await fs.promises.rm(tgzArchivePath, { force: true });
  await fs.promises.rm(zipArchivePath, { force: true });
  await fs.promises.rm(installerScriptPath, { force: true });
  await fs.promises.rm(installerOutputPath, { force: true });
  await fs.promises.mkdir(stagingRoot, { recursive: true });

  await copyProjectSources();

  if (!skipInstall) {
    console.log("安装构建依赖...");
    await run("npm", ["ci", "--include=dev"], { cwd: stagingRoot });
  }

  console.log("构建 Next.js standalone 产物...");
  await run("npm", ["run", "build"], {
    cwd: stagingRoot,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      APP_MODE: presetConfig.appMode,
      APP_START_PATH: presetConfig.startPath,
      APP_BUILD_ID: releaseName
    }
  });

  console.log("组装可交付运行包...");
  await createRuntimePackage();

  if (!skipArchive) {
    console.log("压缩运行包...");
    if (presetConfig.archiveTarGz) {
      await run("tar", ["-czf", tgzArchivePath, "-C", path.dirname(releaseRoot), path.basename(releaseRoot)], { cwd: root });
    }
    if (skipZip) {
      console.log("已按参数跳过 .zip 压缩包。");
    } else if (await commandExists("zip")) {
      await run("zip", ["-qry", zipArchivePath, path.basename(releaseRoot)], { cwd: path.dirname(releaseRoot) });
    } else if (isGrossMarginWindowsPreset() && presetConfig.archiveZip) {
      throw new Error("gross-margin Windows 交付包必须生成 .zip，但当前环境未检测到 zip 命令。请安装 zip，或改用支持 zip 的构建环境。");
    } else if (presetConfig.archiveZip) {
      console.log("未检测到 zip 命令，已跳过 .zip 压缩包。");
    }
    await verifyReleaseArchives();
  }

  if (presetConfig.installerExe && !skipArchive) {
    console.log("生成 Windows 安装脚本...");
    await writeWindowsInstallerScript();
    if (skipInstallerCompile) {
      console.log(`已按参数跳过安装包编译。Inno Setup 脚本：${installerScriptPath}`);
    } else {
      console.log("生成 Windows 安装包...");
      await compileWindowsInstaller();
    }
  }

  console.log("");
  console.log("打包完成：");
  console.log(`  目录：${releaseRoot}`);
  if (!skipArchive) {
    if (presetConfig.archiveTarGz && await exists(tgzArchivePath)) {
      console.log(`  macOS/Linux 压缩包：${tgzArchivePath}`);
    }
    if (await exists(zipArchivePath)) {
      console.log(`  Windows 压缩包：${zipArchivePath}`);
    }
    if (await exists(installerOutputPath)) {
      console.log(`  Windows 安装包：${installerOutputPath}`);
    }
  }
  console.log("");
  console.log(presetConfig.finishHint);
  if (keepWork) console.log(`临时构建目录保留在：${workRoot}`);
  if (!includeLibrary && !isGrossMarginWindowsPreset(preset)) {
    console.log("注意：本次未包含 style-library 数据。若确实要带当前本地数据，重新执行：npm run package:release -- --include-library");
  }
}

function isGrossMarginWindowsPreset(value = preset) {
  return value === "gross-margin-win" || value === "gross-margin-win-installer";
}

function getPresetConfig(value) {
  if (value === "gross-margin-win") {
    return {
      preset: value,
      appMode: "gross-margin",
      startPath: "/gross-margin",
      includeLibraryMode: "gross-margin-only",
      archiveTarGz: false,
      archiveZip: true,
      includeMacLaunchers: false,
      finishHint: "交付给别人时，发 Windows .zip 即可；首次解压后先运行 setup-browser-bridge.cmd，再双击 start.cmd。",
      readmeTitle: "数据维护/监控 Windows 便携包",
      brandName: "数据维护监控",
      installerExe: false,
      userDataDir: ""
    };
  }

  if (value === "gross-margin-win-installer") {
    return {
      preset: value,
      appMode: "gross-margin",
      startPath: "/gross-margin",
      includeLibraryMode: "gross-margin-only",
      archiveTarGz: false,
      archiveZip: true,
      includeMacLaunchers: false,
      finishHint: "交付给别人时，优先发 Windows 安装包 .exe；也会保留 .zip 便携包用于排查。",
      readmeTitle: "数据维护/监控 Windows 安装包",
      brandName: "数据维护监控",
      installerExe: true,
      appId: "{{2B8F195E-84B1-4D8A-9C44-CA9A9E2AA723}",
      appPublisher: "XJX",
      installerBaseName: `${releaseName}-setup`,
      installedAppDirName: "DataMaintenanceMonitor",
      userDataDir: "{userappdata}\\DataMaintenanceMonitor"
    };
  }

  return {
    preset: "portable",
    appMode: "workspace",
    startPath: "/douyin-hotlist",
    includeLibraryMode: includeLibrary ? "all" : "empty",
    archiveTarGz: true,
    archiveZip: true,
    includeMacLaunchers: true,
    finishHint: "交付给别人时，发压缩包即可；Windows 优先发 .zip，解压后运行 start.cmd 或 start.bat。",
    readmeTitle: "账号风格库本地运行包",
    brandName: "账号风格库",
    installerExe: false,
    userDataDir: ""
  };
}

function readOption(flag) {
  const direct = rawArgs.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = rawArgs.indexOf(flag);
  if (index >= 0) return rawArgs[index + 1] || "";
  return "";
}

async function copyProjectSources() {
  const entries = [
    "src",
    "public",
    "middleware.ts",
    "package.json",
    "package-lock.json",
    "next.config.mjs",
    "tsconfig.json",
    "next-env.d.ts"
  ];

  for (const entry of entries) {
    const source = path.join(root, entry);
    if (!(await exists(source))) continue;
    await fs.promises.cp(source, path.join(stagingRoot, entry), { recursive: true });
  }
}

async function createRuntimePackage() {
  const standaloneRoot = path.join(stagingRoot, ".next", "standalone");
  if (!(await exists(path.join(standaloneRoot, "server.js")))) {
    throw new Error('未找到 .next/standalone/server.js，请确认 next.config.mjs 已设置 output: "standalone"。');
  }

  await fs.promises.cp(standaloneRoot, releaseRoot, { recursive: true });
  await fs.promises.mkdir(path.join(releaseRoot, ".next"), { recursive: true });
  await fs.promises.cp(path.join(stagingRoot, ".next", "static"), path.join(releaseRoot, ".next", "static"), { recursive: true });

  if (await exists(path.join(stagingRoot, "public"))) {
    await fs.promises.cp(path.join(stagingRoot, "public"), path.join(releaseRoot, "public"), { recursive: true });
  }

  await copyReleaseLibrary();
  await bundleWindowsNode();
  await patchWindowsRuntimeNativePackages();
  await bundleOpenCli();

  await fs.promises.mkdir(path.join(releaseRoot, "tools"), { recursive: true });
  await fs.promises.writeFile(path.join(releaseRoot, "tools", "runtime.mjs"), runtimeScript(), "utf8");
  await fs.promises.writeFile(path.join(releaseRoot, ".env.example"), releaseEnvExample(), "utf8");
  await fs.promises.writeFile(path.join(releaseRoot, "README.md"), releaseReadme(), "utf8");
  await fs.promises.writeFile(path.join(releaseRoot, "README-使用说明.md"), releaseReadme(), "utf8");
  await fs.promises.writeFile(path.join(releaseRoot, "VERSION.txt"), versionText(), "utf8");

  for (const [fileName, content] of Object.entries(launcherFiles())) {
    const target = path.join(releaseRoot, fileName);
    await fs.promises.writeFile(target, isWindowsLauncher(fileName) ? toCrLf(content) : content, "utf8");
    if (!fileName.endsWith(".bat") && !fileName.endsWith(".cmd")) await fs.promises.chmod(target, 0o755);
  }

  await verifyGrossMarginWindowsPackage();
}

async function copyReleaseLibrary() {
  const targetLibraryRoot = path.join(releaseRoot, "style-library");
  await fs.promises.mkdir(targetLibraryRoot, { recursive: true });

  if (presetConfig.includeLibraryMode === "all" && await exists(path.join(root, "style-library"))) {
    await fs.promises.cp(path.join(root, "style-library"), targetLibraryRoot, { recursive: true });
    return;
  }

  if (presetConfig.includeLibraryMode === "gross-margin-only") {
    const sourceGrossMargin = await resolveGrossMarginLibrarySource();
    const targetGrossMargin = path.join(targetLibraryRoot, "gross-margin");
    if (sourceGrossMargin) {
      console.log(`复制毛利数据源：${sourceGrossMargin}`);
      await fs.promises.cp(sourceGrossMargin, targetGrossMargin, { recursive: true });
    } else {
      console.log("已按 --allow-empty-gross-margin 生成空毛利数据目录。");
      await fs.promises.mkdir(targetGrossMargin, { recursive: true });
    }
    await fs.promises.writeFile(path.join(targetGrossMargin, ".keep"), "", "utf8");
    await fs.promises.writeFile(path.join(targetLibraryRoot, ".keep"), "", "utf8");
    return;
  }

  await fs.promises.writeFile(path.join(targetLibraryRoot, ".keep"), "", "utf8");
}

async function resolveGrossMarginLibrarySource() {
  const explicitSource = (process.env.GROSS_MARGIN_LIBRARY_SOURCE || "").trim();
  const source = explicitSource
    ? resolveInputPath(explicitSource)
    : path.join(root, "style-library", "gross-margin");

  if (await exists(source)) {
    if (await isDirectory(source)) return source;
    throw new Error(`毛利数据源不是目录：${source}`);
  }

  if (allowEmptyGrossMargin) {
    const sourceLabel = explicitSource ? `GROSS_MARGIN_LIBRARY_SOURCE=${source}` : source;
    console.log(`未找到毛利数据源（${sourceLabel}）。`);
    return "";
  }

  const sourceHint = explicitSource
    ? `GROSS_MARGIN_LIBRARY_SOURCE 指向的目录不存在：${source}`
    : `当前仓库没有毛利数据目录：${source}`;
  throw new Error(
    `${preset} 需要明确的毛利数据源，但 ${sourceHint}。\n` +
    "请创建当前仓库 style-library/gross-margin，或设置 GROSS_MARGIN_LIBRARY_SOURCE 指向要交付的数据目录；如确实要生成空包，请追加 --allow-empty-gross-margin。"
  );
}

function resolveInputPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

async function bundleWindowsNode() {
  if (!isGrossMarginWindowsPreset()) return;

  const bundledNode = process.env.WINDOWS_NODE_DIR || "";
  const detectedNode = bundledNode && await exists(path.join(bundledNode, "node.exe"))
    ? bundledNode
    : await findWindowsNodeBundle();

  if (!detectedNode) {
    throw new Error(
      `${preset} 打包需要可用的 Windows Node 运行时。请先设置 WINDOWS_NODE_DIR，指向包含 node.exe 的 Windows Node 目录。`
    );
  }

  const target = path.join(releaseRoot, "runtime", "node");
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.cp(detectedNode, target, { recursive: true });
}

async function findWindowsNodeBundle() {
  const candidates = [
    process.env.WINDOWS_NODE_DIR || "",
    path.join(root, ".vendor", "node-win-x64"),
    path.join(root, ".vendor", "node-win-arm64"),
    path.join(root, "vendor", "node-win-x64"),
    path.join(root, "vendor", "node-win-arm64")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await exists(path.join(candidate, "node.exe"))) return candidate;
  }

  for (const baseDir of [path.join(root, ".vendor"), path.join(root, "vendor")]) {
    if (!(await exists(baseDir))) continue;
    const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
    const matched = entries
      .filter((entry) => entry.isDirectory() && /win-(x64|arm64)/i.test(entry.name))
      .map((entry) => path.join(baseDir, entry.name));
    for (const candidate of matched) {
      if (await exists(path.join(candidate, "node.exe"))) return candidate;
    }
  }

  return "";
}

async function bundleOpenCli() {
  if (!isGrossMarginWindowsPreset()) return;

  const packageRoot = await installBundledOpenCli();
  await patchBundledOpenCliForWindows(packageRoot);
  const targetRoot = path.join(releaseRoot, "runtime", "node_modules");
  await fs.promises.mkdir(path.dirname(targetRoot), { recursive: true });
  await fs.promises.cp(packageRoot, targetRoot, { recursive: true });
}

async function installBundledOpenCli() {
  const installRoot = path.join(workRoot, "bundled-opencli");
  await fs.promises.rm(installRoot, { recursive: true, force: true });
  await fs.promises.mkdir(installRoot, { recursive: true });
  await run("npm", ["install", `@jackwener/opencli@${bundledOpenCliVersion}`], { cwd: installRoot });
  return path.join(installRoot, "node_modules");
}

async function patchBundledOpenCliForWindows(nodeModulesRoot) {
  const lifecycleFile = path.join(
    nodeModulesRoot,
    "@jackwener",
    "opencli",
    "dist",
    "src",
    "browser",
    "daemon-lifecycle.js"
  );
  if (!(await exists(lifecycleFile))) {
    throw new Error(`内置 opencli 缺少 daemon-lifecycle.js：${lifecycleFile}`);
  }

  const source = await fs.promises.readFile(lifecycleFile, "utf8");
  if (source.includes("windowsHide: true")) return;

  const before = "        env: { ...process.env },\n    });";
  const after = "        env: { ...process.env },\n        windowsHide: true,\n    });";
  if (!source.includes(before)) {
    throw new Error("无法给内置 opencli daemon 补充 windowsHide，opencli 启动逻辑可能已变化。");
  }

  await fs.promises.writeFile(lifecycleFile, source.replace(before, after), "utf8");
}

async function writeWindowsInstallerScript() {
  if (!presetConfig.installerExe) return;

  await fs.promises.mkdir(path.dirname(installerScriptPath), { recursive: true });
  await fs.promises.writeFile(installerScriptPath, windowsInstallerScript(), "utf8");
}

async function compileWindowsInstaller() {
  if (!presetConfig.installerExe) return;
  if (!(await exists(installerScriptPath))) {
    throw new Error(`未找到 Inno Setup 脚本：${installerScriptPath}`);
  }

  const iscc = await resolveInnoSetupCompiler();
  if (!iscc) {
    throw new Error(
      `未检测到 Inno Setup 编译器 ISCC。请在 Windows 环境安装 Inno Setup，或使用 GitHub Actions 构建安装包。\n已生成脚本：${installerScriptPath}`
    );
  }

  await run(iscc, [installerScriptPath], { cwd: root });
}

async function resolveInnoSetupCompiler() {
  const configured = process.env.INNO_SETUP_COMPILER || process.env.ISCC || "";
  if (configured && await exists(configured)) return configured;

  const candidates = [
    "iscc",
    "ISCC.exe",
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe"
  ];

  for (const candidate of candidates) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (await exists(candidate)) return candidate;
      continue;
    }
    if (await executableOnPath(candidate)) return candidate;
  }

  return "";
}

function executableOnPath(command) {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [command] : ["-v", command];
    const child = spawn(probe, args, {
      cwd: root,
      stdio: "ignore",
      shell: process.platform !== "win32",
      windowsHide: true
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function patchWindowsRuntimeNativePackages() {
  if (!isGrossMarginWindowsPreset()) return;

  const nodeModulesRoot = path.join(releaseRoot, "node_modules");
  const installRoot = path.join(workRoot, "windows-native-runtime");
  await fs.promises.rm(installRoot, { recursive: true, force: true });
  await fs.promises.mkdir(installRoot, { recursive: true });

  const sharpPackageJson = path.join(nodeModulesRoot, "sharp", "package.json");
  if (await exists(sharpPackageJson)) {
    const sharpPackage = JSON.parse(await fs.promises.readFile(sharpPackageJson, "utf8"));
    const sharpVersion = sharpPackage.version;
    const libvipsVersion = sharpPackage.optionalDependencies?.["@img/sharp-libvips-win32-x64"];
    if (sharpVersion) {
      const packages = [`@img/sharp-win32-x64@${sharpVersion}`];
      if (libvipsVersion) packages.push(`@img/sharp-libvips-win32-x64@${libvipsVersion}`);
      await run("npm", [
        "install",
        "--force",
        "--ignore-scripts",
        ...packages
      ], { cwd: installRoot });
      await copyScopedPackage(
        path.join(installRoot, "node_modules", "@img", "sharp-win32-x64"),
        path.join(nodeModulesRoot, "@img", "sharp-win32-x64")
      );
      if (libvipsVersion) {
        await copyScopedPackage(
          path.join(installRoot, "node_modules", "@img", "sharp-libvips-win32-x64"),
          path.join(nodeModulesRoot, "@img", "sharp-libvips-win32-x64")
        );
      }
    }
  }

  await removePlatformNativePackages(path.join(nodeModulesRoot, "@img"), [
    /^sharp-darwin-/,
    /^sharp-linux/,
    /^sharp-libvips-darwin-/,
    /^sharp-libvips-linux/
  ]);
}

async function copyScopedPackage(source, target) {
  if (!(await exists(source))) return;
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.cp(source, target, { recursive: true });
}

async function removePlatformNativePackages(scopeRoot, patterns) {
  if (!(await exists(scopeRoot))) return;
  const entries = await fs.promises.readdir(scopeRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && patterns.some((pattern) => pattern.test(entry.name)))
      .map((entry) => fs.promises.rm(path.join(scopeRoot, entry.name), { recursive: true, force: true }))
  );
}

async function verifyGrossMarginWindowsPackage() {
  if (!isGrossMarginWindowsPreset()) return;

  const requiredPaths = [
    ["内置 Node", path.join(releaseRoot, "runtime", "node", "node.exe")],
    ["opencli 脚本", path.join(releaseRoot, "runtime", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js")],
    ["启动脚本", path.join(releaseRoot, "start.cmd")],
    ["Browser Bridge 设置脚本", path.join(releaseRoot, "setup-browser-bridge.cmd")],
    ["opencli doctor 脚本", path.join(releaseRoot, "opencli-doctor.cmd")],
    ["毛利数据目录", path.join(releaseRoot, "style-library", "gross-margin")]
  ];

  const missing = [];
  for (const [label, target] of requiredPaths) {
    if (!(await exists(target))) missing.push(`${label}：${target}`);
  }

  const sharpRoot = path.join(releaseRoot, "node_modules", "@img");
  if (await exists(path.join(releaseRoot, "node_modules", "sharp")) && !(await exists(path.join(sharpRoot, "sharp-win32-x64")))) {
    missing.push(`Windows sharp 原生依赖：${path.join(sharpRoot, "sharp-win32-x64")}`);
  }

  if (missing.length) {
    throw new Error(`${preset} 包缺少必要文件：\n${missing.join("\n")}`);
  }
}

async function verifyReleaseArchives() {
  if (!isGrossMarginWindowsPreset() || skipZip) return;
  if (!(await exists(zipArchivePath))) {
    throw new Error(`gross-margin Windows 交付包缺少 .zip：${zipArchivePath}`);
  }
}

function launcherFiles() {
  const files = {
    "start.bat": windowsRuntimeLauncher("start", "启动", "--open"),
    "start.cmd": windowsRuntimeLauncher("start", "启动", "--open"),
    "stop.bat": windowsRuntimeLauncher("stop", "停止"),
    "stop.cmd": windowsRuntimeLauncher("stop", "停止"),
    "status.bat": windowsRuntimeLauncher("status", "状态"),
    "status.cmd": windowsRuntimeLauncher("status", "状态"),
    "create-desktop-shortcut.bat": windowsDesktopShortcutLauncher(),
    "create-desktop-shortcut.cmd": windowsDesktopShortcutLauncher(),
    "setup-browser-bridge.bat": windowsBrowserBridgeSetupLauncher(),
    "setup-browser-bridge.cmd": windowsBrowserBridgeSetupLauncher(),
    "opencli-doctor.bat": windowsOpenCliDoctorLauncher(),
    "opencli-doctor.cmd": windowsOpenCliDoctorLauncher(),
    "install-deps.bat": windowsInstallDepsLauncher(),
    "install-deps.cmd": windowsInstallDepsLauncher()
  };

  if (!presetConfig.includeMacLaunchers) {
    return files;
  }

  return {
    "start.sh": `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先运行 ./install-deps.sh，或安装 Node.js 22.19+。"
  exit 1
fi
node tools/runtime.mjs start --open "$@"
`,
    "stop.sh": `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。"
  exit 1
fi
node tools/runtime.mjs stop "$@"
`,
    "status.sh": `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。"
  exit 1
fi
node tools/runtime.mjs status "$@"
`,
    "install-deps.sh": `#!/usr/bin/env bash
set -euo pipefail

echo "检查本机运行环境..."

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "安装 Node.js..."
    brew install node
  else
    echo "未检测到 Node.js。请先安装 Node.js 22.19+：https://nodejs.org/"
    echo "macOS 推荐先安装 Homebrew，再执行：brew install node"
    exit 1
  fi
fi

if ! command -v opencli >/dev/null 2>&1; then
  echo "安装 opencli..."
  npm install -g @jackwener/opencli
else
  echo "opencli 已安装：$(command -v opencli)"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "安装 ffmpeg..."
    brew install ffmpeg
  else
    echo "未检测到 ffmpeg。需要视频转写时请安装 ffmpeg：https://ffmpeg.org/download.html"
  fi
else
  echo "ffmpeg 已安装：$(command -v ffmpeg)"
fi

echo "依赖检查完成。"
`,
    "start.command": `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
./start.sh
echo
read -n 1 -s -r -p "服务已在后台运行。按任意键关闭这个窗口..."
echo
`,
    "stop.command": `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
./stop.sh
echo
read -n 1 -s -r -p "按任意键关闭这个窗口..."
echo
`,
    "status.command": `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
./status.sh
echo
read -n 1 -s -r -p "按任意键关闭这个窗口..."
echo
`,
    "install-deps.command": `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
./install-deps.sh
echo
read -n 1 -s -r -p "按任意键关闭这个窗口..."
echo
`,
    ...files
  };
}

function windowsRuntimeLauncher(command, label, extraArgs = "") {
  return `@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ${presetConfig.brandName} - ${label}

cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入运行目录："%~dp0"
  echo 请先把压缩包完整解压到一个普通文件夹，再运行本脚本。
  pause
  exit /b 1
)

set "BUNDLED_NODE=%~dp0runtime\\node\\node.exe"
set "NODE_BIN=node"
if exist "%BUNDLED_NODE%" set "NODE_BIN=%BUNDLED_NODE%"

echo 当前目录：%CD%
echo.

if not exist "%NODE_BIN%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未检测到可用的 Node.js。
    echo gross-margin-win 便携包应内置 node.exe；如果文件缺失，请重新解压或重新打包。
    pause
    exit /b 1
  )
) else (
  echo 使用内置 Node：
  echo %NODE_BIN%
)

echo Node 版本：
"%NODE_BIN%" -v
echo.

"%NODE_BIN%" "%~dp0tools\\runtime.mjs" ${command}${extraArgs ? ` ${extraArgs}` : ""}
set EXIT_CODE=%ERRORLEVEL%
echo.

if not "%EXIT_CODE%"=="0" (
  echo ${label}失败，错误码：%EXIT_CODE%
  echo 如果这里没有明确错误，请查看 .runtime\\server.log。
) else (
  echo ${label}命令执行完成。
  if "${command}"=="start" echo 如果浏览器没有自动打开，请访问：http://localhost:3000${presetConfig.startPath}
)

pause
exit /b %EXIT_CODE%
`;
}

function windowsOpenCliDoctorLauncher() {
  return `@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ${presetConfig.brandName} - opencli doctor

cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入运行目录："%~dp0"
  echo 请先把压缩包完整解压到一个普通文件夹，再运行本脚本。
  pause
  exit /b 1
)

set "BUNDLED_NODE=%~dp0runtime\\node\\node.exe"
set "NODE_BIN=node"
if exist "%BUNDLED_NODE%" set "NODE_BIN=%BUNDLED_NODE%"

if not exist "%NODE_BIN%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未检测到可用的 Node.js。
    echo gross-margin-win 便携包应内置 node.exe；如果文件缺失，请重新解压或重新打包。
    pause
    exit /b 1
  )
)

echo 正在检查 opencli Browser Bridge...
echo.
"%NODE_BIN%" "%~dp0tools\\runtime.mjs" opencli-doctor
set EXIT_CODE=%ERRORLEVEL%
echo.

if "%EXIT_CODE%"=="0" (
  echo opencli Browser Bridge 检查完成。
) else (
  echo opencli Browser Bridge 检查未通过，错误码：%EXIT_CODE%
  echo 请先运行 setup-browser-bridge.cmd 安装/启用浏览器扩展后再试。
)

pause
exit /b %EXIT_CODE%
`;
}

function windowsBrowserBridgeSetupLauncher() {
  return `@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ${presetConfig.brandName} - Browser Bridge 设置

cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入运行目录："%~dp0"
  echo 请先把压缩包完整解压到一个普通文件夹，再运行本脚本。
  pause
  exit /b 1
)

set "BUNDLED_NODE=%~dp0runtime\\node\\node.exe"
set "NODE_BIN=node"
if exist "%BUNDLED_NODE%" set "NODE_BIN=%BUNDLED_NODE%"

if not exist "%NODE_BIN%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未检测到可用的 Node.js。
    echo gross-margin-win 便携包应内置 node.exe；如果文件缺失，请重新解压或重新打包。
    pause
    exit /b 1
  )
)

echo 这一步用于让 opencli 连接 Chrome / Edge 浏览器。
echo B站 / 抖音实时刷新需要这个 Browser Bridge 扩展。
echo.
echo 即将打开 OpenCLI 扩展安装页：
echo ${openCliExtensionStoreUrl}
echo.
start "" "${openCliExtensionStoreUrl}"
start "" "chrome://extensions/"
start "" "edge://extensions/"
echo 如果商店无法打开，可手动从这里下载扩展：
echo ${openCliExtensionReleaseUrl}
echo.
echo 请在浏览器中安装并启用 OpenCLI 扩展，保持浏览器打开。
echo 安装完成后回到本窗口，按任意键运行连通性检查。
pause >nul
echo.

"%NODE_BIN%" "%~dp0tools\\runtime.mjs" opencli-doctor
set EXIT_CODE=%ERRORLEVEL%
echo.

if "%EXIT_CODE%"=="0" (
  echo Browser Bridge 已可用。现在可以运行 start.cmd。
) else (
  echo Browser Bridge 仍未连通，错误码：%EXIT_CODE%
  echo 请确认扩展已启用、Chrome / Edge 正在运行，并重新执行本脚本。
)

pause
exit /b %EXIT_CODE%
`;
}

function windowsInstallDepsLauncher() {
  if (isGrossMarginWindowsPreset()) {
    return `@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ${presetConfig.brandName} - 依赖检查

cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入运行目录："%~dp0"
  echo 请先把压缩包完整解压到一个普通文件夹，再运行本脚本。
  pause
  exit /b 1
)

echo 这个专用包已内置 Node.js 和 opencli 主程序，不需要安装全局 opencli。
echo B站 / 抖音实时刷新还需要浏览器里的 OpenCLI Browser Bridge 扩展。
echo.
call "%~dp0setup-browser-bridge.cmd"
set EXIT_CODE=%ERRORLEVEL%
echo.
echo 如需无字幕视频转写，请另外确认本机已安装 ffmpeg。
pause
exit /b %EXIT_CODE%
`;
  }

  return `@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ${presetConfig.brandName} - 安装依赖

cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入运行目录："%~dp0"
  echo 请先把压缩包完整解压到一个普通文件夹，再运行本脚本。
  pause
  exit /b 1
)

echo 当前目录：%CD%
echo.

set "BUNDLED_NODE=%~dp0runtime\\node\\node.exe"
set "NODE_BIN=node"
if exist "%BUNDLED_NODE%" set "NODE_BIN=%BUNDLED_NODE%"

if exist "%NODE_BIN%" (
  echo 使用内置 Node：
  echo %NODE_BIN%
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    where winget >nul 2>nul
    if errorlevel 1 (
      echo 未检测到 Node.js，也没有检测到 winget。
      echo 请手动安装 Node.js 22.19+：https://nodejs.org/
      pause
      exit /b 1
    )
    echo 安装 Node.js LTS...
    winget install OpenJS.NodeJS.LTS
    echo.
    echo 如果 Node.js 刚安装完成，请关闭本窗口后重新运行 install-deps.cmd。
    pause
    exit /b 0
  )
)

echo Node 版本：
"%NODE_BIN%" -v
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm。请重新安装 Node.js LTS。
  pause
  exit /b 1
)

where opencli >nul 2>nul
if errorlevel 1 (
  echo 安装 opencli...
  call npm install -g @jackwener/opencli
) else (
  echo opencli 已安装
)
echo.

where ffmpeg >nul 2>nul
if errorlevel 1 (
  where winget >nul 2>nul
  if errorlevel 1 (
    echo 未检测到 ffmpeg。只有需要无字幕视频转写时才需要它，可稍后手动安装：https://ffmpeg.org/download.html
  ) else (
    echo 安装 ffmpeg...
    winget install Gyan.FFmpeg
  )
) else (
  echo ffmpeg 已安装
)

echo.
echo 依赖检查完成。现在可以运行 start.cmd。
pause
`;
}

function windowsDesktopShortcutLauncher() {
  return `@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ${presetConfig.brandName} - 创建桌面快捷方式

cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入运行目录："%~dp0"
  echo 请先把压缩包完整解压到一个普通文件夹，再运行本脚本。
  pause
  exit /b 1
)

set "SHORTCUT_NAME=${presetConfig.brandName}.lnk"
set "DESKTOP_DIR=%USERPROFILE%\\Desktop"
set "SHORTCUT_PATH=%DESKTOP_DIR%\\%SHORTCUT_NAME%"
set "TARGET_PATH=%~dp0start.cmd"
set "ICON_PATH=%~dp0runtime\\node\\node.exe"

if not exist "%DESKTOP_DIR%" (
  echo 没找到桌面目录：%DESKTOP_DIR%
  pause
  exit /b 1
)

if not exist "%TARGET_PATH%" (
  echo 没找到启动脚本：%TARGET_PATH%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$WshShell = New-Object -ComObject WScript.Shell; ^
   $Shortcut = $WshShell.CreateShortcut('%SHORTCUT_PATH%'); ^
   $Shortcut.TargetPath = '%TARGET_PATH%'; ^
   $Shortcut.WorkingDirectory = '%~dp0'; ^
   $Shortcut.WindowStyle = 1; ^
   if (Test-Path '%ICON_PATH%') { $Shortcut.IconLocation = '%ICON_PATH%,0'; } ^
   $Shortcut.Description = '${presetConfig.brandName}'; ^
   $Shortcut.Save()"

if errorlevel 1 (
  echo 创建桌面快捷方式失败。请确认 Windows PowerShell 可用。
  pause
  exit /b 1
)

echo.
echo 已创建桌面快捷方式：
echo %SHORTCUT_PATH%
echo.
echo 以后可以直接双击桌面上的“${presetConfig.brandName}”启动。
pause
`;
}

function windowsInstallerScript() {
  const sourceDir = escapeInnoPath(releaseRoot);
  const outputDir = escapeInnoPath(path.dirname(installerOutputPath));
  const setupBaseName = path.basename(installerOutputPath, ".exe");
  const appVersion = packageJson.version || "0.0.0";
  const brandName = presetConfig.brandName;
  const dataDir = presetConfig.userDataDir || "{userappdata}\\DataMaintenanceMonitor";
  const dataStyleLibrary = `${dataDir}\\style-library`;
  const dataGrossMargin = `${dataStyleLibrary}\\gross-margin`;

  return `#define MyAppName "${escapeInnoString(brandName)}"
#define MyAppVersion "${escapeInnoString(appVersion)}"
#define MyAppPublisher "${escapeInnoString(presetConfig.appPublisher || "XJX")}"
#define MyAppExeName "start.cmd"

[Setup]
AppId=${presetConfig.appId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\\Programs\\${escapeInnoString(presetConfig.installedAppDirName || "DataMaintenanceMonitor")}
DefaultGroupName={#MyAppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=${outputDir}
OutputBaseFilename=${escapeInnoString(setupBaseName)}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=lowest
WizardStyle=modern
UninstallDisplayIcon={app}\\runtime\\node\\node.exe

[Files]
Source: "${sourceDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".runtime\\*,style-library\\gross-margin\\*"
Source: "${sourceDir}\\style-library\\gross-margin\\*"; DestDir: "${dataGrossMargin}"; Flags: ignoreversion recursesubdirs createallsubdirs onlyifdoesntexist

[Dirs]
Name: "${dataStyleLibrary}"
Name: "${dataGrossMargin}"

[Icons]
Name: "{autoprograms}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\\runtime\\node\\node.exe"
Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\\runtime\\node\\node.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项："; Flags: checkedonce

[Run]
Filename: "{app}\\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  EnvPath: String;
  EnvText: String;
begin
  if CurStep = ssPostInstall then
  begin
    EnvPath := ExpandConstant('{app}\\.env');
    EnvText :=
      'PORT=3000' + #13#10 +
      'APP_MODE=${presetConfig.appMode}' + #13#10 +
      'APP_START_PATH=${presetConfig.startPath}' + #13#10 +
      'OPENCLI_BIN=./runtime/node/node.exe' + #13#10 +
      'OPENCLI_NODE_BIN=./runtime/node/node.exe' + #13#10 +
      'OPENCLI_SCRIPT=./runtime/node_modules/@jackwener/opencli/dist/src/main.js' + #13#10 +
      'OPENCLI_BROWSER_CONNECT_TIMEOUT=8' + #13#10 +
      'OPENCLI_WINDOW=background' + #13#10 +
      'FFMPEG_BIN=ffmpeg' + #13#10 +
      'STYLE_LIBRARY_DIR=' + ExpandConstant('${escapeInnoPascalString(dataStyleLibrary)}') + #13#10;
    if not FileExists(EnvPath) then
      SaveStringToFile(EnvPath, EnvText, False);
  end;
end;
`;
}

function escapeInnoPath(value) {
  return value.replace(/\//g, "\\");
}

function escapeInnoString(value) {
  return String(value).replace(/"/g, '""');
}

function escapeInnoPascalString(value) {
  return String(value).replace(/'/g, "''");
}

function runtimeScript() {
  return `import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import process from "process";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, ".runtime");
const pidFile = path.join(stateDir, "server.pid");
const logFile = path.join(stateDir, "server.log");
const command = process.argv[2] || "start";
const openAfterStart = process.argv.includes("--open");

await main();

async function main() {
  await ensureDefaultEnvFile();
  const fileEnv = readDotEnv(path.join(root, ".env"));
  assertPresetInvariant(fileEnv, "APP_MODE", "${presetConfig.appMode}");
  assertPresetInvariant(fileEnv, "APP_START_PATH", "${presetConfig.startPath}");
  const env = {
    ...fileEnv,
    ...process.env,
    NODE_ENV: "production",
    PORT: envValue(fileEnv, "PORT", "3000"),
    HOSTNAME: envValue(fileEnv, "HOSTNAME", "127.0.0.1"),
    APP_MODE: "${presetConfig.appMode}",
    APP_START_PATH: "${presetConfig.startPath}",
    OPENCLI_BIN: envValue(fileEnv, "OPENCLI_BIN", bundledOpenCliCommand()),
    OPENCLI_NODE_BIN: envValue(fileEnv, "OPENCLI_NODE_BIN", bundledOpenCliNode()),
    OPENCLI_SCRIPT: envValue(fileEnv, "OPENCLI_SCRIPT", bundledOpenCliScript()),
    OPENCLI_BROWSER_CONNECT_TIMEOUT: envValue(fileEnv, "OPENCLI_BROWSER_CONNECT_TIMEOUT", "8"),
    OPENCLI_WINDOW: envValue(fileEnv, "OPENCLI_WINDOW", "background"),
    STYLE_LIBRARY_DIR: envValue(fileEnv, "STYLE_LIBRARY_DIR", "./style-library"),
    APP_BUILD_ID: "${releaseName}"
  };

  await fs.promises.mkdir(stateDir, { recursive: true });
  await fs.promises.mkdir(path.resolve(root, env.STYLE_LIBRARY_DIR), { recursive: true });
  if (env.APP_MODE === "gross-margin") {
    await fs.promises.mkdir(path.resolve(root, env.STYLE_LIBRARY_DIR, "gross-margin"), { recursive: true });
  }

  if (command === "start") return start(env);
  if (command === "stop") return stop();
  if (command === "restart") {
    await stop({ quiet: true });
    return start(env);
  }
  if (command === "status") return status(env);
  if (command === "opencli-doctor") return openCliDoctor(env);

  console.error("用法：node tools/runtime.mjs <start|stop|restart|status|opencli-doctor>");
  process.exit(1);
}

async function start(env) {
  const current = readPid();
  const port = Number(env.PORT || 3000);
  const url = buildUrl(port, env.APP_START_PATH || "${presetConfig.startPath}");

  if (current && isRunning(current)) {
    console.log(\`服务已在运行：pid=\${current}\`);
    console.log(\`地址：\${url}\`);
    if (openAfterStart) openBrowser(url);
    return;
  }

  const listener = await canConnect(port);
  if (listener) {
    console.error(\`端口 \${port} 已被占用。请修改 .env 里的 PORT，或先关闭占用该端口的程序。\`);
    process.exit(1);
  }

  const serverPath = path.join(root, "server.js");
  if (!fs.existsSync(serverPath)) {
    console.error("缺少 server.js，请确认运行的是完整发布包。");
    process.exit(1);
  }

  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
    windowsHide: true
  });
  child.unref();
  fs.writeFileSync(pidFile, \`\${child.pid}\\n\`, "utf8");
  fs.closeSync(logFd);

  const ready = await waitForHealth(port, 20000, child);
  if (!ready) {
    console.error("服务启动失败或健康检查未通过。请查看下面的日志片段。");
    printLogTail();
    signalProcess(child.pid, "SIGTERM");
    fs.rmSync(pidFile, { force: true });
    process.exit(1);
  }

  console.log(\`已启动：pid=\${child.pid}\`);
  console.log(\`地址：\${url}\`);
  console.log(\`日志：\${logFile}\`);
  printToolWarnings(env);
  if (ready && openAfterStart) openBrowser(url);
}

async function stop(options = {}) {
  const pid = readPid();
  if (!pid) {
    if (!options.quiet) console.log("没有找到后台服务 pid。");
    return;
  }

  if (!isRunning(pid)) {
    fs.rmSync(pidFile, { force: true });
    if (!options.quiet) console.log(\`后台服务已不在运行，已清理 pid：\${pid}\`);
    return;
  }

  signalProcess(pid, "SIGTERM");
  const stopped = await waitForStop(pid, 5000);
  if (!stopped) signalProcess(pid, "SIGKILL");
  fs.rmSync(pidFile, { force: true });
  if (!options.quiet) console.log(\`已停止后台服务：pid=\${pid}\`);
}

async function status(env) {
  const pid = readPid();
  const port = Number(env.PORT || 3000);
  const info = {
    pid,
    pidRunning: pid ? isRunning(pid) : false,
    port,
    reachable: await canConnect(port),
    url: buildUrl(port, env.APP_START_PATH || "${presetConfig.startPath}"),
    appMode: env.APP_MODE || "workspace",
    styleLibrary: path.resolve(root, env.STYLE_LIBRARY_DIR || "./style-library"),
    logFile,
    opencli: env.OPENCLI_SCRIPT ? \`\${env.OPENCLI_NODE_BIN || process.execPath} \${env.OPENCLI_SCRIPT}\` : resolveExecutable(env.OPENCLI_BIN || "opencli") || null,
    ffmpeg: resolveExecutable(env.FFMPEG_BIN || "ffmpeg") || null
  };
  console.log(JSON.stringify(info, null, 2));
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

function signalProcess(pid, signal) {
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

async function waitForStop(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isRunning(pid)) return true;
    await delay(200);
  }
  return false;
}

async function waitForPort(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnect(port)) return true;
    await delay(250);
  }
  return false;
}

async function waitForHealth(port, timeoutMs, child) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) return false;
    if (await requestHealth(port)) return true;
    await delay(500);
  }
  return false;
}

function requestHealth(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 3000 }, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300));
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(800);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  const lines = fs.readFileSync(file, "utf8").split(/\\r?\\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = unquoteEnv(match[2].trim());
  }
  return env;
}

function unquoteEnv(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function envValue(fileEnv, key, fallback) {
  return fileEnv[key] || process.env[key] || fallback;
}

function assertPresetInvariant(fileEnv, key, expected) {
  const actual = fileEnv[key];
  if (!actual || actual === expected) return;
  console.error(\`.env 中的 \${key}=\${actual} 与当前发布包要求的 \${key}=\${expected} 不一致。\`);
  console.error("请还原 .env，或重新按目标 preset 打包。");
  process.exit(1);
}

async function ensureDefaultEnvFile() {
  const target = path.join(root, ".env");
  if (fs.existsSync(target)) return;
  await fs.promises.writeFile(target, \`${minimalEnv().replace(/`/g, "\\`")}\`, "utf8");
}

function buildUrl(port, startPath) {
  const cleanPath = startPath && startPath.startsWith("/") ? startPath : \`/\${startPath || ""}\`;
  return \`http://localhost:\${port}\${cleanPath}\`;
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
}

function printToolWarnings(env) {
  const opencli = env.OPENCLI_SCRIPT ? resolveOpenCliScript(env) : resolveExecutable(env.OPENCLI_BIN || "opencli");
  const ffmpeg = resolveExecutable(env.FFMPEG_BIN || "ffmpeg");
  if (!opencli) console.log("提示：未检测到 opencli，页面仍可使用，但 B站/抖音实时刷新不可用。可运行 install-deps 脚本安装。");
  if (opencli && env.APP_MODE === "gross-margin") console.log("提示：首次刷新 B站/抖音前，请先运行 setup-browser-bridge.cmd，确保 opencli Browser Bridge 已连接。");
  if (!ffmpeg) console.log("提示：未检测到 ffmpeg。只有需要无字幕视频转写时才需要它，可运行 install-deps 脚本安装。");
}

function printLogTail() {
  if (!fs.existsSync(logFile)) {
    console.error(\`日志文件尚未生成：\${logFile}\`);
    return;
  }
  const lines = fs.readFileSync(logFile, "utf8").split(/\\r?\\n/).slice(-80).join("\\n");
  console.error(lines);
}

async function openCliDoctor(env) {
  const runtime = resolveOpenCliRuntime(env);
  if (!runtime) {
    console.error("未检测到 opencli。请确认发布包完整，或重新解压后再试。");
    process.exit(1);
  }

  console.log(\`opencli：\${runtime.label}\`);
  console.log("如果提示 Extension not connected，请运行 setup-browser-bridge.cmd 安装/启用浏览器扩展。");
  console.log("");

  const code = await runChild(runtime.command, [...runtime.argsPrefix, "doctor"], {
    env: {
      ...process.env,
      ...env,
      OPENCLI_BROWSER_CONNECT_TIMEOUT: env.OPENCLI_BROWSER_CONNECT_TIMEOUT || "8"
    },
    timeoutMs: 45000
  });
  process.exit(code);
}

function resolveOpenCliRuntime(env) {
  const script = resolveOpenCliScript(env);
  if (script) {
    const nodeBin = resolveExecutable(env.OPENCLI_NODE_BIN || process.execPath);
    if (nodeBin) {
      return {
        command: nodeBin,
        argsPrefix: [script],
        label: \`\${nodeBin} \${script}\`
      };
    }
  }

  const bin = resolveExecutable(env.OPENCLI_BIN || "opencli");
  return bin ? { command: bin, argsPrefix: [], label: bin } : null;
}

function runChild(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: options.env || process.env,
      windowsHide: true
    });
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          console.error(\`命令超时：\${command} \${args.join(" ")}\`);
          child.kill("SIGTERM");
          resolve(1);
        }, options.timeoutMs)
      : null;

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      console.error(error instanceof Error ? error.message : String(error));
      resolve(1);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function resolveOpenCliScript(env) {
  const nodeBin = env.OPENCLI_NODE_BIN || process.execPath;
  const script = env.OPENCLI_SCRIPT || "";
  const nodeResolved = resolveExecutable(nodeBin);
  const scriptResolved = script ? path.resolve(root, script) : "";
  return nodeResolved && scriptResolved && fs.existsSync(scriptResolved) ? scriptResolved : "";
}

function resolveExecutable(command) {
  if (!command) return "";
  if (command.includes("/") || command.includes("\\\\")) {
    const absolute = path.resolve(root, command);
    return fs.existsSync(absolute) ? absolute : fs.existsSync(command) ? command : "";
  }
  const pathList = (process.env.PATH || "").split(path.delimiter);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathList) {
    for (const extension of extensions) {
      const target = path.join(dir, \`\${command}\${extension}\`);
      if (fs.existsSync(target)) return target;
    }
  }
  return "";
}
`;
}

function releaseEnvExample() {
  const common = `${minimalEnv()}

# 可选：火山引擎录音文件识别 2.0，用于无字幕视频转写。
VOLCENGINE_ASR_API_KEY=
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.auc
VOLCENGINE_ASR_SUBMIT_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit
VOLCENGINE_ASR_QUERY_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/query
VOLCENGINE_ASR_AUDIO_FORMAT=mp3
VOLCENGINE_ASR_POLL_INTERVAL_MS=1000
VOLCENGINE_ASR_MAX_POLL_ATTEMPTS=120
VOLCENGINE_ASR_REQUEST_TIMEOUT_MS=30000
VOLCENGINE_ASR_RETRY_COUNT=2
DOUYIN_TRANSCRIBE_CONCURRENCY=3
`;

  if (isGrossMarginWindowsPreset()) {
    return `${common}
# 数据维护 / 数据监控本地运行不需要大模型。
# 只有其他写作、风格卡、评论生成能力才需要下面这些变量。
# CHAT_API_KEY=
# CHAT_BASE_URL=https://api.openai.com/v1
# CHAT_MODEL=
# CHAT_WIRE_API=auto
# CHAT_REASONING_EFFORT=none
# CHAT_PROXY_URL=
`;
  }

  return `${common}
# 可选：文案、风格卡、评论生成等大模型能力。
# 数据维护监控不需要大模型；不填 API Key 也可以使用本地数据维护功能。
# CHAT_API_KEY=
# CHAT_BASE_URL=https://api.openai.com/v1
# CHAT_MODEL=
# CHAT_WIRE_API=auto
# CHAT_REASONING_EFFORT=none
# CHAT_PROXY_URL=

# 可选：封面图生成。
# IMAGE_API_KEY=
# IMAGE_BASE_URL=https://api.openai.com/v1
# IMAGE_MODEL=
# IMAGE_SIZE=2048x1152
# IMAGE_QUALITY=medium
# IMAGE_FORMAT=jpeg
# IMAGE_PROXY_URL=

# 可选：飞书文档发布。
FEISHU_OPENCLI_AS=user
FEISHU_FOLDER_TOKEN=
`;
}

function minimalEnv() {
  return `PORT=3000
APP_MODE=${presetConfig.appMode}
APP_START_PATH=${presetConfig.startPath}
OPENCLI_BIN=${isGrossMarginWindowsPreset() ? "./runtime/node/node.exe" : "opencli"}
OPENCLI_NODE_BIN=${isGrossMarginWindowsPreset() ? "./runtime/node/node.exe" : ""}
OPENCLI_SCRIPT=${isGrossMarginWindowsPreset() ? "./runtime/node_modules/@jackwener/opencli/dist/src/main.js" : ""}
OPENCLI_BROWSER_CONNECT_TIMEOUT=8
OPENCLI_WINDOW=background
FFMPEG_BIN=ffmpeg
STYLE_LIBRARY_DIR=./style-library
`;
}

function releaseReadme() {
  if (isGrossMarginWindowsPreset()) {
    return `# ${presetConfig.readmeTitle}

这是面向 Windows 的数据维护 / 数据监控专用便携包。它不是单文件 exe，而是解压后双击启动的本地网页工具。

## 最短使用路径

1. 完整解压 .zip，不要在压缩包预览窗口里直接双击。
2. 首次使用先双击 \`setup-browser-bridge.cmd\`，按提示安装/启用 OpenCLI 浏览器扩展，直到检查通过。
3. 双击 \`start.cmd\`。
4. 浏览器会自动打开 \`http://localhost:3000/gross-margin\`。

如果想让对方以后直接双击桌面图标启动，再额外运行一次 \`create-desktop-shortcut.cmd\`。

## 这包里已经带了什么

- 已构建好的本地网页程序
- Windows 内置 Node 运行时
- 已内置可直接使用的 \`opencli\` 主程序
- 数据维护 / 数据监控专用启动脚本
- 打包时只会从显式 \`GROSS_MARGIN_LIBRARY_SOURCE\` 或当前仓库 \`style-library/gross-margin\` 复制毛利数据

## 还需要你自己准备什么

- 实时刷新 B站 / 抖音数据需要浏览器里的 OpenCLI Browser Bridge 扩展；运行 \`setup-browser-bridge.cmd\` 会打开安装页并执行 \`opencli doctor\`
- 只有无字幕视频转写时才需要 \`ffmpeg\`
- 不需要配置任何大模型 API Key，就能使用数据维护 / 数据监控

## 常用脚本

- \`start.cmd\`：启动并打开浏览器
- \`stop.cmd\`：停止后台服务
- \`status.cmd\`：查看运行状态
- \`setup-browser-bridge.cmd\`：安装/启用 OpenCLI 浏览器扩展并检查连通性
- \`opencli-doctor.cmd\`：重新检查 opencli Browser Bridge 状态
- \`create-desktop-shortcut.cmd\`：在桌面创建一个可直接启动的快捷方式
- \`install-deps.cmd\`：兼容旧说明的依赖检查入口，会转到 Browser Bridge 设置

## 常见问题

- 页面能打开，但刷新很慢或日志里有 \`BROWSER_CONNECT\` / \`Extension not connected\`：运行 \`setup-browser-bridge.cmd\`，确认 Chrome / Edge 已安装并启用 OpenCLI 扩展。
- 想让别人以后直接点桌面图标：先运行 \`create-desktop-shortcut.cmd\`。
- 浏览器没自动打开：手动访问 \`http://localhost:3000/gross-margin\`。
- 端口冲突：编辑 \`.env\`，把 \`PORT=3000\` 改成其他端口。
- 日志排查：查看 \`.runtime\\server.log\`。
`;
  }

  return `# ${presetConfig.readmeTitle}

这是已经构建好的本地网页工具包，解压后可以直接在本机启动。

## 一键启动

macOS：

1. 首次使用先运行 \`install-deps.command\`，安装/检查 Node.js、opencli、ffmpeg。
2. 双击 \`start.command\` 启动，会自动打开 \`http://localhost:3000${presetConfig.startPath}\`。
3. 停止服务运行 \`stop.command\`，查看状态运行 \`status.command\`。

终端：

\`\`\`bash
./install-deps.sh
./start.sh
./status.sh
./stop.sh
\`\`\`

Windows：

1. 请使用 \`.zip\` 压缩包，并先完整解压，不要在压缩包预览窗口里直接双击。
2. 首次使用运行 \`install-deps.cmd\`。
3. 双击 \`start.cmd\` 启动；如果浏览器没有自动打开，访问 \`http://localhost:3000${presetConfig.startPath}\`。
4. 用 \`stop.cmd\` 停止服务，\`status.cmd\` 查看状态。

## 数据和配置

- 本地数据默认保存在包内 \`style-library\` 目录。
- 首次启动会自动生成 \`.env\`；需要改端口、模型、火山转写或飞书配置时，编辑 \`.env\`。
- 数据维护 / 数据监控不需要大模型，只需要 opencli 能抓到平台数据。
- 文案生成、风格提炼、评论生成、封面生成等能力才需要配置模型或图片 API Key。

## 常见问题

- 页面打不开：运行 \`status\` 脚本确认服务是否启动；也可以看 \`.runtime/server.log\`。
- 端口被占用：编辑 \`.env\`，把 \`PORT=3000\` 改成其他端口，例如 \`PORT=3010\`。
- B 站/抖音采集失败：先运行 \`opencli doctor\` 或重新执行 \`install-deps\`。
- 视频转写失败：确认已安装 \`ffmpeg\`，并在 \`.env\` 配置火山转写 API Key。
- macOS 无法双击打开：右键脚本，选择“打开”；或者在终端运行 \`./start.sh\`。
- Windows 双击无反应：先右键解压 \`.zip\` 到普通目录，再双击 \`start.cmd\`；窗口会保留错误信息，也可以查看 \`.runtime\\server.log\`。
`;
}

function versionText() {
  return [
    `name=${packageJson.name || ""}`,
    `version=${packageJson.version || ""}`,
    `preset=${preset}`,
    `builtAt=${new Date().toISOString()}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `node=${process.version}`,
    `includeLibrary=${includeLibrary ? "true" : "false"}`,
    `buildId=${releaseName}`,
    ""
  ].join("\n");
}

function exists(target) {
  return fs.promises.access(target).then(() => true, () => false);
}

function isDirectory(target) {
  return fs.promises.stat(target).then((stat) => stat.isDirectory(), () => false);
}

function isWindowsLauncher(fileName) {
  return fileName.endsWith(".bat") || fileName.endsWith(".cmd");
}

function toCrLf(content) {
  return content.replace(/\r?\n/g, "\r\n");
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      cwd: root,
      stdio: "ignore",
      shell: process.platform === "win32",
      windowsHide: true
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}
