import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRadarPipelineConfig } from "../src/lib/hotspot-radar/config";
import { selectUnifiedCandidates, deduplicateUnifiedSignals } from "../src/lib/hotspot-radar/unified-sources";
import { eventGroupingSchema, buildEventSignals } from "../src/lib/hotspot-radar/events";
import { analyzeRadar } from "../src/lib/hotspot-radar/analysis";
import { getHotspotRadar, retainPriorityTopics } from "../src/lib/hotspots";
import type { RadarSignal } from "../src/lib/hotspot-radar/source-rules.mjs";
import { writeSupportDocumentCache } from "../src/lib/storage/support-documents";

const item = (id: string, kind: "rss" | "hotlist" | "video" = "rss"): RadarSignal => ({ id, sourceId: kind, source: kind, originalSource: kind, title: `游戏官方回应玩家争议 ${id}`, summary: "官方发布声明", url: `https://example.com/${id}`, category: "游戏", publishedAt: kind === "hotlist" ? "" : new Date().toISOString(), collectedAt: new Date().toISOString(), inputKind: kind });

test("统一候选按类型均衡、配置排除、URL去重保留来源，排除视频输入", () => {
  const config = { ...getRadarPipelineConfig(), candidateLimit: 12, exclude: ["屏蔽"] };
  const inputs = [...Array.from({length:30}, (_, i) => item(`rss-${i}`)), item("榜单", "hotlist"), item("视频", "video"), {...item("过滤"), title:"屏蔽内容"}];
  const selected = selectUnifiedCandidates(inputs, config);
  assert.equal(selected.length, 12);
  assert.ok(selected.every(row => row.inputKind !== "video"));
  assert.ok(selected.some(row => row.inputKind === "hotlist"));
  assert.ok(selected.every(row => row.title !== "屏蔽内容"));
  const duplicate = {...item("b"),url:inputs[0].url+"?utm_source=rss"};
  assert.equal(deduplicateUnifiedSignals([inputs[0],duplicate])[0].related?.[0].id,"b");
  assert.equal(eventGroupingSchema([item("a"),item("b")],[]).safeParse({events:[{signalIds:["a"]}]}).success,false);
  assert.equal(eventGroupingSchema([item("a")],[]).safeParse({events:[{signalIds:["invented"]}]}).success,false);
});

test("统一事件链路：无日期榜单与RSS归并，排除视频，缓存、进展、续跑和失败边界", async () => {
  const env={...process.env};
  const root=await mkdtemp(path.join(tmpdir(),"radar-unified-"));
  const seen: string[]=[];
  let invalid=false;
  let finePayload: Record<string, unknown>[]=[];
  const server=createServer(async(req,res)=>{
    let text="";for await(const part of req) text+=part;
    const request=JSON.parse(text);const data=JSON.parse(request.messages[1].content);const system=request.messages[0].content;
    let value;
    if(system.includes("事件归并编辑")) {
      seen.push("group");
      value={events:[{signalIds:invalid?["invented"]:data.candidates.map((row:{id:string})=>row.id),...(data.previous[0]?{previousEventId:data.previous[0].id,development:"官方补充处罚决定"}:{})}]};
    } else if(system.includes("第一轮")) {seen.push("coarse");value={items:data.items.map((row:{id:string})=>({signalId:row.id,coarseReason:"人物反转"}))};}
    else if(system.includes("资深")) {seen.push("fine");finePayload=data.items;value={items:data.items.map((row:{id:string})=>({signalId:row.id,subject:"测试游戏",titleZh:"官方回应玩家争议",summaryZh:"官方提供进一步回应",type:"突发运营",grade:"能做",whyHot:"官方回应节点",commentDirection:"讨论回应",entryPoint:"回应解决问题了吗"}))};}
    else {seen.push("report");value={headline:"日报",overview:"概览",signals:[],communityMood:"编辑预测",tomorrowWatch:[]};}
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address==="object");
  for(const key of Object.keys(process.env))if(/^(CHAT_|OPENAI_|FHL_|HOTSPOT_RADAR_)/.test(key))delete process.env[key];
  Object.assign(process.env,{STYLE_LIBRARY_DIR:root,CHAT_API_KEY:"test",CHAT_MODEL:"test",CHAT_BASE_URL:`http://127.0.0.1:${address.port}/v1`,CHAT_WIRE_API:"chat_completions"});
  const signals=[item("rss"),item("hot","hotlist"),item("video","video")];
  const feedback={schemaVersion:1 as const,ratings:[],history:[]};
  try {
    const config=getRadarPipelineConfig();
    for (const signal of signals.filter(row=>row.inputKind!=="video")) await writeSupportDocumentCache({url:signal.url,provider:"web",content:"官方提供可核实的回应正文。"});
    const first=await analyzeRadar(signals,feedback,{pipeline:config,reuseAnalysis:true,enrichEvidence:true});
    assert.equal(first.hotspots.length,1);
    assert.equal(first.analysis.eventCount,1);
    assert.equal(first.hotspots[0].signalIds.length,2);
    assert.equal(first.hotspots[0].timeline?.length,2);
    assert.equal((finePayload[0].related as unknown[]).length,1);
    assert.equal(await first.report(first.hotspots),undefined);
    assert.ok(!seen.includes("report"),"默认不额外生成日报");
    const count=seen.length;
    await analyzeRadar(signals,feedback,{pipeline:config,reuseAnalysis:true,enrichEvidence:true});
    assert.equal(seen.length,count,"相同材料复用粗筛、事件归并和精筛");
    await analyzeRadar(signals,feedback,{pipeline:config,reuseAnalysis:true,enrichEvidence:true,completedSignalIds:first.completedSignalIds});
    assert.equal(seen.length,count,"继续分析跳过已完成事件");
    await analyzeRadar(signals.map(signal => ({ ...signal, metrics: { rank: 2, likes: 9999 } })),feedback,{pipeline:config,reuseAnalysis:true,enrichEvidence:true,completedSignalIds:first.completedSignalIds});
    assert.equal(seen.length,count,"热度变化不重新调用粗筛、归并或精筛");
    const fresh=item("new-response");
    const next=await analyzeRadar([...signals,fresh],feedback,{pipeline:config,previousTopics:first.hotspots,reuseAnalysis:true});
    assert.equal(next.hotspots[0].id,first.hotspots[0].id);
    assert.equal(next.hotspots[0].development,"官方补充处罚决定");
    assert.ok(finePayload[0].previousContext,"新进展带入旧背景");
    assert.equal(next.hotspots[0].gradeLabel,"能做","缺少正文不覆盖编辑价值");
    assert.equal(next.hotspots[0].status,"watch");
    assert.match(next.hotspots[0].displayInfo.statusLine,/正文待补充/);
    const empty=await getHotspotRadar();
    const merged=retainPriorityTopics({...empty,hotspots:first.hotspots},next.hotspots);
    assert.equal(merged.length,1);
    assert.equal(merged[0].timeline?.length,3);
    const grouped=buildEventSignals(signals.filter(row=>row.inputKind!=="video"),first.hotspots,{events:[{signalIds:signals.filter(row=>row.inputKind!=="video").map(row=>row.id),previousEventId:first.hotspots[0].id}]});
    assert.equal(grouped[0].previousContext,undefined,"相同指纹不反复把旧摘要送入模型");
    invalid=true;
    await assert.rejects(analyzeRadar([item("invalid-new")],feedback,{pipeline:config,reuseAnalysis:true}),/格式无效/);
    invalid=false;
    const beforeRetry=seen.filter(stage=>stage==="group").length;
    await analyzeRadar([item("invalid-new")],feedback,{pipeline:config,reuseAnalysis:true});
    assert.equal(seen.filter(stage=>stage==="group").length,beforeRetry+1,"非法事件归并不写缓存");
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(analyzeRadar(signals,feedback,{pipeline:config,signal:aborted.signal}));
  } finally {
    server.close();
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);
    await rm(root,{recursive:true,force:true});
  }
});

test("兼容旧输入配置但不允许重新启用视频热榜", () => {
  const previous = process.env.HOTSPOT_RADAR_INPUTS;
  try {
    process.env.HOTSPOT_RADAR_INPUTS = "hotlist,rss,video";
    assert.deepEqual(getRadarPipelineConfig().sources, ["hotlist", "rss"]);
    process.env.HOTSPOT_RADAR_INPUTS = "video";
    assert.throws(() => getRadarPipelineConfig(), /热点分析配置无效/);
  } finally {
    if (previous === undefined) delete process.env.HOTSPOT_RADAR_INPUTS;
    else process.env.HOTSPOT_RADAR_INPUTS = previous;
  }
});
