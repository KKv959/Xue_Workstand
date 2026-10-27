import { createHash } from "node:crypto";

export const newsNowAsset = "assets/index-BhneVqXQ.js";
const expectedBundleHash = "6f8f29ad9524f8b53408b3f847c7faefbfe501ecfb21e8e88fc4fb36494f5306";
export const digest = value => createHash("sha256").update(value).digest("hex");

function replaceOnce(source, before, after, description) {
  if (source.split(before).length !== 2) throw new Error(`NewsNow ${description}结构不匹配，未应用更新。请核对固定镜像 v0.0.41。`);
  return source.replace(before, after);
}

export function patchNewsNowClient(original, bridge, icons) {
  if (digest(original) !== expectedBundleHash) throw new Error("NewsNow 前端版本不匹配，未应用更新；请使用当前固定镜像 v0.0.41。");
  let source = replaceOnce(original, "function vF(){", "function vF(){if(window.self!==window.top)return D.jsx(WorkbenchFeed,{});", "卡片列表");
  const registration = `${bridge}\nconst WorkbenchFeed=NewsNowWorkbench.createNewsNowWorkbench(E,{Card:HC,sources:ue,columns:Hv,cache:$r,queryClient:uM,request:Ra,icons:${JSON.stringify(icons)}});\n`;
  source = replaceOnce(source, "d1.innerHTML||", `${registration}d1.innerHTML||`, "渲染入口");
  return source;
}

export function patchNewsNowServer(original) {
  let source = replaceOnce(original, 'const latest = query.latest !== void 0 && query.latest !== "false";', 'const latest = query.latest !== void 0 && query.latest !== "false";\n    const forceLatest = latest && (event.context.disabledLogin || event.context.user);', "来源刷新参数");
  source = replaceOnce(source, "      if (cache) {\n        if (now - cache.updated", "      if (cache && !forceLatest) {\n        if (now - cache.updated", "手动刷新缓存");
  source = replaceOnce(source, '            status: "success",\n            id,\n            updatedTime: now,\n            items: cache.items', '            status: "cache",\n            id,\n            updatedTime: cache.updated,\n            items: cache.items', "缓存时间");
  source = replaceOnce(source, '          status: "cache",\n          id,\n          updatedTime: cache.updated,\n          items: cache.items', '          status: "cache",\n          fallback: true,\n          fallbackReason: "拉取最新资讯失败，正在显示上次成功缓存。",\n          id,\n          updatedTime: cache.updated,\n          items: cache.items', "失败缓存回退");
  return source;
}

export function patchNewsNowHtml(html, css, revision) {
  const clean = html.replace(/<style id="workbench-interactions">[\s\S]*?<\/style>/g, "").replace(/\?workbench=[a-f0-9]+/g, "");
  const withAsset = replaceOnce(clean, `src="/${newsNowAsset}"`, `src="/${newsNowAsset}?workbench=${revision}"`, "脚本链接");
  return replaceOnce(withAsset, "</head>", `<style id="workbench-interactions">${css}</style></head>`, "页面模板");
}

export function patchNewsNowManifest(nitro, files) {
  let result = nitro;
  for (const [name, bytes] of Object.entries(files)) {
    const key = `"/${name}": `;
    const start = result.indexOf(key);
    if (start < 0) throw new Error(`NewsNow 静态清单缺少 ${name}，未应用更新。`);
    const entryStart = result.indexOf("{", start + key.length);
    const entryEnd = result.indexOf("}", entryStart);
    const entry = JSON.parse(result.slice(entryStart, entryEnd + 1));
    entry.size = Buffer.byteLength(bytes);
    entry.etag = `"${digest(bytes)}"`;
    entry.mtime = new Date().toISOString();
    result = result.slice(0, entryStart) + JSON.stringify(entry) + result.slice(entryEnd + 1);
  }
  return result;
}
