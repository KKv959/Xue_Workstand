import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveLinkSourceMedia } from "../src/lib/transcription";
import { refreshDouyinVideoDownloadUrl } from "../src/lib/opencli";
import type { Account } from "../src/lib/types";

const id = "7697942603035168042";
const url = `https://www.douyin.com/video/${id}`;
const mediaUrl = "https://video.example.test/source.mp4";
const payload = { aweme_id: id, desc: "真实发布文案", author: "测试作者", author_sec_uid: "author-id",
  cover: "https://image.example.test/cover.jpg", play_url: mediaUrl, images: [], duration_s: 32, created: "2026-10-18 09:49:00" };
const account: Account = { id: "fixture", slug: "fixture", uid: "author-id", platform: "douyin", name: "测试作者", createdAt: "", updatedAt: "" };

async function fixture(run: (events: () => Promise<string[][]>) => Promise<void>) {
  const original = { ...process.env };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected external network in offline test"); };
  const root = await mkdtemp(path.join(tmpdir(), "douyin-detail-test-"));
  const script = path.join(root, "opencli.mjs"), events = path.join(root, "events.jsonl");
  await writeFile(script, `import fs from 'node:fs';
const args=process.argv.slice(2); fs.appendFileSync(process.env.DETAIL_EVENTS, JSON.stringify(args.slice(0,3))+'\\n');
if(args[0]==='douyin' && args[1]==='detail') {
 if(process.env.DETAIL_ERROR) { console.log(JSON.stringify({ok:false,error:{code:'AUTH',message:'HTTP 403 登录失效'}})); process.exit(1); }
 if(process.env.DETAIL_DELAY) await new Promise(r=>setTimeout(r,10000));
 console.log(JSON.stringify({ok:true,data:JSON.parse(process.env.DETAIL_PAYLOAD)}));
} else if(args[0]==='browser' && process.env.DETAIL_BROWSER_MODE) {
 console.log(JSON.stringify({ok:true,data:args.includes('open')?{page:'fixture'}:['https://video.example.test/alternate.mp4']}));
} else { console.error('legacy list/browser path must not run'); process.exit(2); }
`);
  for (const key of Object.keys(process.env)) if (/^OPENCLI_/.test(key)) delete process.env[key];
  Object.assign(process.env, { STYLE_LIBRARY_DIR: root, OPENCLI_SCRIPT: script, OPENCLI_NODE_BIN: process.execPath,
    DETAIL_EVENTS: events, DETAIL_PAYLOAD: JSON.stringify([payload]) });
  try { await run(async () => (await readFile(events,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    globalThis.fetch = originalFetch;
    Object.assign(process.env, original); await rm(root,{recursive:true,force:true});
  }
}

test("单链接用 detail 一次读取标题、作者、封面和媒体，不再额外浏览器补全", async () => fixture(async events => {
  let pageFetches = 0;
  globalThis.fetch = async () => { pageFetches++; throw new Error("完整链接不应额外请求页面"); };
  const result = await resolveLinkSourceMedia({url,platform:"douyin"});
  assert.equal(pageFetches,0);
  assert.equal(result.title, "真实发布文案"); assert.equal(result.sourceAccountName,"测试作者");
  assert.equal(result.coverUrl,payload.cover); assert.deepEqual(result.mediaUrls,[mediaUrl]);
  assert.equal((await events()).length,1);
}));

test("单条媒体补全直接按作品 ID 查详情，不拉作者作品列表", async () => fixture(async events => {
  assert.equal(await refreshDouyinVideoDownloadUrl(account,{id,url,raw:{index:500}}),mediaUrl);
  assert.equal((await events()).length,1);
  assert.equal(await refreshDouyinVideoDownloadUrl(account,{id,url,raw:{}},{excludeUrls:[mediaUrl]}),"");
}));

test("详情 ID 错配、无效返回、非媒体地址和图文作品显式失败", async () => fixture(async () => {
  const cases: Array<[unknown, RegExp]> = [
    [[{...payload,aweme_id:"7698583792730000674"}], /ID.*不匹配/],
    [{}, /无效结果/],
    [[], /ID.*缺失/],
    [[{...payload,play_url:"javascript:alert(1)"}], /有效视频媒体地址/],
    [[{...payload,play_url:"",images:["https://image.example.test/photo.jpg"]}], /图文图集/]
  ];
  for(const [invalid,expected] of cases) {
    process.env.DETAIL_PAYLOAD=JSON.stringify(invalid);
    await assert.rejects(resolveLinkSourceMedia({url,resolvedUrl:url,platform:"douyin"}),expected);
  }
}));

test("读取失败保留中文可操作原因，取消不回退拉列表", async () => fixture(async () => {
  process.env.DETAIL_ERROR="1";
  await assert.rejects(refreshDouyinVideoDownloadUrl(account,{id,url,raw:{}}),/403.*登录|登录.*403/);
  delete process.env.DETAIL_ERROR; process.env.DETAIL_DELAY="1";
  await assert.rejects(refreshDouyinVideoDownloadUrl(account,{id,url,raw:{}},{signal:AbortSignal.timeout(150)}), error=>error instanceof Error && /Abort|停止|取消/.test(error.name+error.message));
}));


test("短链详情返回标准作品 URL，避免把分享地址作为媒体地址", async () => fixture(async events => {
  const share = "https://v.douyin.com/example/";
  const result = await resolveLinkSourceMedia({url:share,resolvedUrl:share,platform:"douyin"});
  assert.equal(result.resolvedUrl,url);
  assert.deepEqual(result.mediaUrls,[mediaUrl]);
  assert.deepEqual((await events())[0],["douyin","detail",share]);
}));

test("音轨失败时显式请求浏览器可获得另一地址，不会重拉作者列表", async () => fixture(async () => {
  process.env.DETAIL_BROWSER_MODE="1";
  const result=await refreshDouyinVideoDownloadUrl(account,{id,url,raw:{}},{preferBrowser:true,excludeUrls:[mediaUrl]});
  assert.equal(result,"https://video.example.test/alternate.mp4");
}));
