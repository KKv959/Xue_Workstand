import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCoordinatedCommentSection, buildEngagementResearchPlanningPrompt, buildPlatformResearchTasks, buildSourceStats, filterQuarantinedVideoCommentSamples, normalizeEngagementResearchPlan } from "../src/lib/engagement-research";
import {
  isExcludedRelatedVideo
} from "../src/lib/opencli-normalizers";



test("全网评论调研不再使用固定评论类别比例", async () => {
  const source = await import("../src/lib/engagement-research");
  assert.equal("buildEngagementResearchLaneSequence" in source, false);
});

test("相关视频搜索在抓评论前排除输入视频本身", () => {
  assert.equal(isExcludedRelatedVideo("7684475511262825737", ["7684475511262825737"]), true);
  assert.equal(isExcludedRelatedVideo("BV1ABC123456", ["bv1abc123456"]), true);
  assert.equal(isExcludedRelatedVideo("7682995913781972258", ["7684475511262825737"]), false);
});

test("高一致营销模板会被识别为人机评论区", () => {
  const analysis = analyzeCoordinatedCommentSection([
    "真的太好用了，效率直接拉满！",
    "颜值在线实力也在线，闭眼入不亏",
    "用了以后幸福感提升太多，真心推荐",
    "质感满满，性价比真的拉满了",
    "功能全面又实用，这波直接冲",
    "体验感绝了，买到就是赚到",
    "细节做得很到位，值得入手",
    "这才是年轻人的首选，已经安排上了"
  ]);

  assert.equal(analysis.quarantined, true);
  assert.ok(analysis.signals.marketingRatio >= 0.75);
  assert.match(analysis.reasons.join("；"), /广告结论|购买号召|营销话术/);
});

test("商单视频下的自然分歧评论不会仅因商业属性被误杀", () => {
  const analysis = analyzeCoordinatedCommentSection([
    "这价格我还是先看看吧",
    "有没有人说下真实续航？",
    "镜头那段没看懂，为啥突然切了",
    "我用上一代，最大问题其实是发热",
    "笑死，评论区已经有人开始算分期了",
    "别急着冲，等第一批用户反馈",
    "外观确实好看，但这个颜色不耐脏吧",
    "路过蹲一个半年后的评测"
  ]);

  assert.equal(analysis.quarantined, false);
  assert.ok(analysis.signals.naturalStanceRatio >= 0.5);
});

test("一个视频命中人机评论源后整组评论全部隔离", () => {
  const samples = [
    { platform: "douyin" as const, videoId: "ad-video", text: "模板夸赞一" },
    { platform: "douyin" as const, videoId: "ad-video", text: "看起来像真人的一条" },
    { platform: "douyin" as const, videoId: "organic-video", text: "正常评论" },
    { platform: "bilibili" as const, videoId: "ad-video", text: "不同平台同 ID 不连坐" }
  ];

  assert.deepEqual(
    filterQuarantinedVideoCommentSamples(samples, ["douyin:ad-video"]),
    [samples[2], samples[3]]
  );
});

test("B站评论调研只采 B站，抖音保留双平台采集", () => {
  assert.deepEqual(buildPlatformResearchTasks("苹果折叠屏", "bilibili"), [
    { source: "bilibili", query: "苹果折叠屏", videoLimit: 2 }
  ]);
  assert.deepEqual(buildPlatformResearchTasks("苹果折叠屏", "douyin"), [
    { source: "douyin", query: "苹果折叠屏", videoLimit: 2 },
    { source: "bilibili", query: "苹果折叠屏", videoLimit: 2 }
  ]);
});

test("只采抖音时，不把未请求的 B站报告成失败", () => {
  const rows = [{ source: "douyin" as const, query: "篮球少女", videos: [], comments: [], replyCommentCount: 0, thresholdLabel: "未命中", error: "没有自然评论" }];
  const stats = buildSourceStats(rows);
  assert.deepEqual(stats.map((row) => row.source), ["douyin"]);
  assert.equal(stats[0].status, "failed");
  assert.equal(stats[0].error, "没有自然评论");
});

const shortAnchorBrief = {
  summary: "呆皇下单百万陪玩", topic: "呆皇陪玩约战", subjects: ["呆皇"],
  keyFacts: ["呆皇下单陪玩"], discussionAngles: [], skepticalAngles: [], anchorTerms: ["呆皇"]
};





test("关键词计划保留 AI 的语义表达、顺序和数量，不按原文字面过滤", () => {
  const queries = ["折叠手机真的适合普通人吗", "苹果入局折叠屏的意义"];
  assert.deepEqual(normalizeEngagementResearchPlan({ queries }), { queries, anchors: [], eventTerms: [] });
  assert.deepEqual(normalizeEngagementResearchPlan({ queries: ["为什么还要买直板机"], anchors: ["普通消费者"], eventTerms: ["选择成本"] }), {
    queries: ["为什么还要买直板机"], anchors: ["普通消费者"], eventTerms: ["选择成本"]
  });
});

test("计划只拒绝错误格式和超过执行上限，不静默截断", () => {
  for (const value of [{ queries: [] }, { queries: [42] }, { queries: [""] }, { queries: "关键词" }, { queries: Array(3).fill("词") }]) {
    assert.throws(() => normalizeEngagementResearchPlan(value));
  }
});

test("正文理解阶段接收全文，不注入机械摘要或具体搜索词示例", () => {
  const fullText = "正文内容。".repeat(3000) + "结尾的真正观点";
  const prompt = buildEngagementResearchPlanningPrompt({ ...shortAnchorBrief, fullText });
  assert.ok(prompt.includes(fullText));
  assert.equal(prompt.includes(shortAnchorBrief.summary), false);
});

test("搜索来源依据必须和每个词一一对应并保留，不能只生成后丢失", () => {
  const sources = [{ query: "少女篮球", videoType: "宣传片讨论", discussion: "对校园故事的反应" }];
  assert.deepEqual(normalizeEngagementResearchPlan({ queries: ["少女篮球"], sources }).sources, sources);
  assert.throws(() => normalizeEngagementResearchPlan({ queries: ["少女篮球"], sources: [] }), /每个搜索词/);
  assert.throws(() => normalizeEngagementResearchPlan({ queries: ["少女篮球"], sources: [{ ...sources[0], query: "别的游戏" }] }), /不匹配/);
});
