import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sourceEntries = [
  "src", "public", "scripts", "tests", "middleware.ts", "eslint.config.mjs",
  "package.json", "package-lock.json", "next.config.mjs", "tsconfig.json"
];
const environmentFiles = [".env", ".env.local", ".env.production", ".env.production.local", ".npmrc"];

// 文件内容、名称与权限均参与校验；不把密钥原文写入发布元数据。
export async function hashEntries(root, entries, artifact = false) {
  const hash = crypto.createHash("sha256");
  async function visit(relative) {
    // Next 图片/请求缓存运行时会变化，不属于可执行产物。
    if (artifact && relative === path.join(".next", "cache")) return;
    const target = path.join(root, relative);
    let stat;
    try { stat = await fs.promises.lstat(target); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update(JSON.stringify([relative, "missing"]));
      return;
    }
    hash.update(JSON.stringify([relative, stat.mode & 0o777]));
    if (stat.isSymbolicLink()) {
      if (!artifact) throw new Error(`发布输入包含符号链接，无法生成独立源码快照：${relative}`);
      const link = await fs.promises.readlink(target);
      const resolved = path.relative(root, path.resolve(path.dirname(target), link));
      if (resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error(`发布输入包含越界符号链接：${relative}`);
      hash.update(JSON.stringify(["link", link]));
    } else if (stat.isDirectory()) {
      hash.update("directory");
      for (const name of (await fs.promises.readdir(target)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(["file", stat.size]));
      for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    } else {
      throw new Error(`发布输入包含不支持的文件：${relative}`);
    }
  }
  for (const entry of [...entries].sort()) await visit(entry);
  return hash.digest("hex");
}

export async function releaseInputs(root, env, npmVersion) {
  const sourceDigest = await hashEntries(root, sourceEntries);
  const configDigest = await hashEntries(root, environmentFiles);
  // npm 入口和 Codex 调用元数据不影响构建；工具调用 ID 每次都会变化。
  const invocationKeys = ["PWD", "OLDPWD", "SHLVL", "_", "INIT_CWD", "npm_lifecycle_event", "npm_lifecycle_script", "npm_command"];
  const environment = Object.entries(env).filter(([key]) => !invocationKeys.includes(key) && !key.startsWith("CODEX_")).sort(([a], [b]) => a.localeCompare(b));
  const installationInputs = await hashEntries(root, ["package.json", "package-lock.json", ".npmrc"]);
  const dependencyFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    installationInputs, environment, node: process.version, platform: process.platform, arch: process.arch, npmVersion
  })).digest("hex");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    sourceDigest, configDigest, environment, node: process.version,
    platform: process.platform, arch: process.arch, npmVersion
  })).digest("hex");
  return { fingerprint, sourceDigest, dependencyFingerprint };
}

export async function hashArtifact(root) {
  const entries = (await fs.promises.readdir(root)).filter(name => !["HEALTHY", "FAILED"].includes(name));
  return hashEntries(root, entries, true);
}

export async function writeJsonAtomic(target, value) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

export async function readCandidate(stateRoot, fingerprint) {
  let candidate;
  try { candidate = JSON.parse(await fs.promises.readFile(path.join(stateRoot, "candidate.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (!(error instanceof SyntaxError)) throw error;
    console.warn("候选记录损坏，将重新验证构建。");
    return null;
  }
  if (candidate?.schemaVersion !== 1 || candidate.fingerprint !== fingerprint ||
      typeof candidate.buildId !== "string" || !/^[\w-]+$/.test(candidate.buildId) || candidate.validation !== "build-passed") return null;
  const releaseRoot = path.join(stateRoot, "releases", candidate.buildId);
  try {
    const build = JSON.parse(await fs.promises.readFile(path.join(releaseRoot, "REMOTE_BUILD.json"), "utf8"));
    if (build.buildId !== candidate.buildId || build.fingerprint !== fingerprint) return null;
    await fs.promises.access(path.join(releaseRoot, "server.js"));
    if (fs.existsSync(path.join(releaseRoot, "FAILED"))) return null;
    if (await hashArtifact(releaseRoot) !== candidate.artifactDigest) {
      console.warn("候选产物校验不一致，将重新验证构建。");
      return null;
    }
    return { ...candidate, releaseRoot };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
