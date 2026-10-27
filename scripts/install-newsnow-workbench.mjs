import { readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GripVertical, EyeOff, Eye, X, RotateCcw, Check } from "lucide-react";
import { digest, newsNowAsset, patchNewsNowClient, patchNewsNowServer, patchNewsNowHtml, patchNewsNowManifest } from "./lib/newsnow-adapter.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const deployment = path.resolve(process.env.NEWSNOW_DEPLOYMENT_DIR || path.join(os.homedir(), "Applications/newsnow"));
const theme = path.join(deployment, "theme");
const container = "workbench-newsnow-newsnow-1";
const run = promisify(execFile);
const apply = process.argv.includes("--apply");
const { writeTextFileAtomic } = await import("../src/lib/storage/fs.ts");

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function upstream(name, containerPath) {
  const backup = path.join(theme, name);
  if (await exists(backup)) return readFile(backup, "utf8");
  const { stdout } = await run("docker", ["exec", container, "cat", containerPath], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
  if (apply) await writeTextFileAtomic(backup, stdout);
  return stdout;
}

try {
  const [originalClient, originalServer, renderer, staticHtml, worker, nitro, compose, css, bridgeBuild] = await Promise.all([
    upstream("upstream-workbench-client.js", `output/public/${newsNowAsset}`),
    upstream("upstream-workbench-source.mjs", "output/server/chunks/routes/api/index2.mjs"),
    readFile(path.join(theme, "renderer.mjs"), "utf8"),
    readFile(path.join(theme, "index.html"), "utf8"),
    readFile(path.join(theme, "swx.js"), "utf8"),
    readFile(path.join(theme, "nitro.mjs"), "utf8"),
    readFile(path.join(deployment, "compose.yaml"), "utf8"),
    readFile(path.join(root, "src/app/hotspots/newsnow-workbench.css"), "utf8"),
    build({ entryPoints: [path.join(root, "src/lib/newsnow-workbench.tsx")], bundle: true, write: false, format: "iife", globalName: "NewsNowWorkbench", jsxFactory: "React.createElement", jsxFragment: "React.Fragment", target: "es2022", minify: true, logLevel: "silent" }),
  ]);
  const icons = Object.fromEntries(Object.entries({ grip: GripVertical, hide: EyeOff, show: Eye, close: X, reset: RotateCcw, check: Check }).map(([key, Icon]) => [key, renderToStaticMarkup(createElement(Icon, { size: 16, strokeWidth: 1.75 }))]));
  const client = patchNewsNowClient(originalClient, bridgeBuild.outputFiles[0].text, icons);
  const server = patchNewsNowServer(originalServer);
  const revision = digest(client + css).slice(0, 24);
  const templatePattern = /const template = ("(?:[^"\\]|\\.)*");/;
  const match = renderer.match(templatePattern);
  if (!match) throw new Error("NewsNow 渲染模板不匹配，未应用更新。");
  const newRenderer = renderer.replace(templatePattern, () => `const template = ${JSON.stringify(patchNewsNowHtml(JSON.parse(match[1]), css, revision))};`);
  const newHtml = patchNewsNowHtml(staticHtml, css, revision);
  let newWorker = worker.replace(/(url:"index.html",revision:")[^"]+/, `$1${digest(newHtml).slice(0, 32)}`);
  const escapedAsset = newsNowAsset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const workerAsset = new RegExp(`url:"${escapedAsset}",revision:(?:null|"[^"]*")`);
  if (!workerAsset.test(newWorker)) throw new Error("NewsNow 首页资源缓存清单不匹配，未应用更新。");
  newWorker = newWorker.replace(workerAsset, `url:"${newsNowAsset}",revision:"${digest(client).slice(0, 32)}"`);
  const newNitro = patchNewsNowManifest(nitro, { "index.html": newHtml, "swx.js": newWorker, [newsNowAsset]: client });
  let newCompose = compose;
  for (const mount of [`      - ./theme/workbench-client.js:/usr/app/output/public/${newsNowAsset}:ro`, "      - ./theme/workbench-source.mjs:/usr/app/output/server/chunks/routes/api/index2.mjs:ro"]) {
    if (!newCompose.includes(mount)) newCompose = newCompose.replace("    environment:", `${mount}\n    environment:`);
  }
  if (!newCompose.includes("127.0.0.1:4444:4444") || newCompose === compose && !compose.includes("./theme/workbench-client.js:")) throw new Error("NewsNow 本机部署配置不匹配，未应用更新。");
  console.log(`已校验 NewsNow v0.0.41，交互版本 ${revision}。`);
  if (!apply) {
    console.log("预检查通过。应用：node --import tsx scripts/install-newsnow-workbench.mjs --apply");
  } else {
    // Back up deployment code/config only; the NewsNow data volume and workspace library are untouched.
    for (const file of ["renderer.mjs", "index.html", "swx.js", "nitro.mjs"]) {
      const destination = path.join(theme, `${file}.pre-workbench`);
      if (!await exists(destination)) await writeTextFileAtomic(destination, await readFile(path.join(theme, file), "utf8"));
    }
    if (!await exists(path.join(deployment, "compose.yaml.pre-workbench"))) await writeTextFileAtomic(path.join(deployment, "compose.yaml.pre-workbench"), compose);
    for (const [file, contents] of Object.entries({ "workbench-client.js": client, "workbench-source.mjs": server, "renderer.mjs": newRenderer, "index.html": newHtml, "swx.js": newWorker, "nitro.mjs": newNitro })) await writeTextFileAtomic(path.join(theme, file), contents);
    await writeTextFileAtomic(path.join(deployment, "compose.yaml"), newCompose);
    await run("docker", ["compose", "-p", "workbench-newsnow", "-f", path.join(deployment, "compose.yaml"), "up", "-d", "--force-recreate", "newsnow"], { timeout: 60000, maxBuffer: 1024 * 1024 });
    console.log("NewsNow 全来源刷新、卡片排序和隐藏已应用；容器已更新。");
  }
} catch (error) {
  console.error(`NewsNow 交互安装失败：${error instanceof Error ? error.message : "未知错误，请检查 Docker 和部署目录。"}`);
  process.exitCode = 1;
}
