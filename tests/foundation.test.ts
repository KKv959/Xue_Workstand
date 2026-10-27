import { legacyProject } from "./helpers/legacy-project";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertJobKindAllowedForAppMode,
  isJobKindAllowedForAppMode
} from "../src/lib/app-mode";
import {
  isChatConfigConfigured,
  type ChatRuntimeConfig
} from "../src/lib/model-runtime";
import { prepareWriteCopyBatchContext, prepareWriteCopyContext } from "../src/lib/ai";
import {
  deleteAccounts,
  getVideo,
  readTranscript,
  resolveDraft,
  saveDraft,
  saveTranscript,
  saveVideos,
  upsertAccount,
} from "../src/lib/storage";
import { writeCopyInputSchema } from "../src/lib/write-validation";
import {
  normalizeWriteStyleReferenceInputs,
  parseWriteStyleReferenceKey,
  writeStyleReferenceKey
} from "../src/lib/write-references";
import {
  extractRewriteSourceMaterial,
  restoreWriterSourceInput,
  splitWriterSourceInput
} from "../src/lib/source-extraction";
import { fetchSupportDocuments } from "../src/lib/support-documents";
import { writeSupportDocumentCache } from "../src/lib/storage/support-documents";
import type { Account, Video } from "../src/lib/types";

const execFileAsync = promisify(execFile);

test("毛利模式只允许毛利刷新任务", () => {
  assert.equal(isJobKindAllowedForAppMode("gross-margin-refresh", "gross-margin"), true);
  assert.equal(isJobKindAllowedForAppMode("write-copy", "gross-margin"), false);
  assert.equal(isJobKindAllowedForAppMode("write-copy", "workspace"), true);

  assert.throws(
    () => assertJobKindAllowedForAppMode("collect-account", "gross-margin"),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 403);
      return true;
    }
  );
});

test("完整模型端点不依赖 baseUrl 也能被识别", () => {
  assert.equal(isChatConfigConfigured(chatConfig({
    wireApi: "responses",
    responsesUrl: "https://example.com/responses"
  })), true);
  assert.equal(isChatConfigConfigured(chatConfig({
    wireApi: "chat_completions",
    chatCompletionsUrl: "https://example.com/chat/completions"
  })), true);
  assert.equal(isChatConfigConfigured(chatConfig({
    wireApi: "responses",
    chatCompletionsUrl: "https://example.com/chat/completions"
  })), false);
});

test("同名账号和项目不会覆盖彼此目录", async () => {
  await withTemporaryLibrary(async () => {
    const [firstAccount, secondAccount] = await Promise.all([
      upsertAccount({ platform: "bilibili", name: "同名账号", uid: "uid-1" }),
      upsertAccount({ platform: "bilibili", name: "同名账号", uid: "uid-2" })
    ]);
    assert.notEqual(firstAccount.id, secondAccount.id);
    assert.notEqual(firstAccount.slug, secondAccount.slug);

    const [firstProject, secondProject] = await Promise.all([
      legacyProject({ name: "同名项目" }),
      legacyProject({ name: "同名项目" })
    ]);
    assert.notEqual(firstProject.id, secondProject.id);
    assert.notEqual(firstProject.slug, secondProject.slug);
  });
});

test("写作风格引用支持并发多选、保序去重和旧参数兼容", () => {
  const references = normalizeWriteStyleReferenceInputs({
    styleRefs: [
      { targetType: "account", platform: "bilibili", accountId: "bilibili:first" },
      { targetType: "project", projectId: "project:demo" },
      { targetType: "account", platform: "bilibili", accountId: "bilibili:first" }
    ]
  });

  assert.deepEqual(references, [
    { targetType: "account", platform: "bilibili", accountId: "bilibili:first" },
    { targetType: "project", projectId: "project:demo" }
  ]);
  assert.deepEqual(parseWriteStyleReferenceKey(writeStyleReferenceKey(references[0])), references[0]);
  assert.deepEqual(
    normalizeWriteStyleReferenceInputs({ targetType: "project", projectId: "project:legacy" }),
    [{ targetType: "project", projectId: "project:legacy" }]
  );
  assert.equal(writeCopyInputSchema.safeParse({
    action: "create",
    styleRefs: references.filter(reference => reference.targetType === "account"),
    mode: "topic",
    prompt: "分别按两种风格各写一段"
  }).success, true);
  assert.equal(writeCopyInputSchema.safeParse({
    action: "create",
    styleRefs: Array.from({ length: 9 }, (_, index) => ({
      targetType: "account" as const,
      platform: "douyin" as const,
      accountId: `douyin:style-${index}`
    })),
    mode: "topic",
    prompt: "超出并发上限"
  }).success, false);
});

test("旧版多风格草稿仍会清理已删除的引用", async () => {
  await withTemporaryLibrary(async () => {
    const primary = await upsertAccount({ platform: "bilibili", name: "风格 A", uid: "primary-style" });
    const secondary = await upsertAccount({ platform: "douyin", name: "风格 B", uid: "secondary-style" });
    const project = await legacyProject({ name: "风格项目", sourceAccountIds: [secondary.id] });
    const draft = await saveDraft({
      targetType: "account",
      platform: primary.platform,
      accountId: primary.id,
      accountName: primary.name,
      title: "多风格测试",
      mode: "topic",
      prompt: "测试多风格",
      content: "测试成稿",
      styleRef: {
        platform: primary.platform,
        accountId: primary.id,
        accountName: primary.name
      },
      styleRefs: [
        { targetType: "account", platform: primary.platform, accountId: primary.id, accountName: primary.name },
        { targetType: "project", projectId: project.id, projectName: project.name, sourceAccountIds: project.sourceAccountIds },
        { targetType: "account", platform: secondary.platform, accountId: secondary.id, accountName: secondary.name }
      ]
    });

    assert.equal((await resolveDraft(draft.id)).draft.styleRefs?.length, 3);
    await deleteAccounts([secondary.id]);
    assert.deepEqual((await resolveDraft(draft.id)).draft.styleRefs?.map((reference) => writeStyleReferenceKey(reference)), [
      `account:${primary.platform}:${primary.id}`, `project:${project.id}`
    ]);
  });
});

test("多选风格会拆成互不混合的独立写作上下文", async () => {
  await withTemporaryLibrary(async () => {
    const account = await upsertAccount({ platform: "bilibili", name: "数码风格", uid: "context-account" });
    const other = await upsertAccount({ platform: "douyin", name: "游戏风格", uid: "other-context-account" });
    const prepared = await prepareWriteCopyBatchContext({
      styleRefs: [
        { targetType: "account", platform: account.platform, accountId: account.id },
        { targetType: "account", platform: other.platform, accountId: other.id }
      ],
      mode: "topic",
      prompt: "分别生成风格测试"
    });

    assert.equal(prepared.variants.length, 2);
    assert.equal(prepared.variants[0].prepared.draftBase?.styleRefs?.length, 1);
    assert.equal(prepared.variants[1].prepared.draftBase?.styleRefs?.length, 1);
    assert.match(prepared.variants[0].prepared.messages[1].content, /数码风格/);
    assert.doesNotMatch(prepared.variants[0].prepared.messages[1].content, /游戏风格/);
    assert.match(prepared.variants[1].prepared.messages[1].content, /游戏风格/);
    assert.doesNotMatch(prepared.variants[1].prepared.messages[1].content, /数码风格/);
    assert.match(prepared.variants[0].prepared.messages[0].content, /按所选风格卡和用户要求写作/);
  });
});

test("写作历史会单独保存原始素材输入", async () => {
  await withTemporaryLibrary(async () => {
    const account = await upsertAccount({ platform: "bilibili", name: "原始输入测试", uid: "original-source-input" });
    const originalSourceInput = "第一段素材，保留这里的原始排版。\n\n\n第二段素材，前面有三个换行。";
    const prepared = await prepareWriteCopyContext({
      styleRefs: [{ targetType: "account", platform: account.platform, accountId: account.id }],
      mode: "rewrite",
      prompt: "按风格改写",
      originalSourceInput,
      sourceText: originalSourceInput
    });

    assert.ok(prepared.draftBase);
    assert.equal(prepared.draftBase.originalSourceInput, originalSourceInput);
    assert.equal(prepared.draftBase.input, originalSourceInput);

    const saved = await saveDraft({ ...prepared.draftBase, content: "测试成稿" });
    assert.equal((await resolveDraft(saved.id)).draft.originalSourceInput, originalSourceInput);
  });
});

test("纯文字素材保留段落、空格和缩进，不按空行拆分", () => {
  const source = "第一段保留  双空格。\n\n第二段保留换行。\n  这里还有缩进。";
  const extracted = extractRewriteSourceMaterial(source);

  assert.equal(extracted.materials.length, 1);
  assert.equal(extracted.materials[0].text, source);
  assert.equal(extracted.normalizedText, source);
  assert.equal(extracted.linkCount, 0);
  assert.equal(extracted.pendingLinkCount, 0);
  assert.equal(extracted.textMaterialCount, 1);
});

test("本地文件素材保留文件正文排版", () => {
  const source = "===== 本地文件：口播稿.txt =====\n第一行  保留双空格\n\n  第二段保留缩进\n===== 文件结束 =====";
  const extracted = extractRewriteSourceMaterial(source);

  assert.equal(extracted.materials.length, 1);
  assert.equal(extracted.materials[0].text, source);
  assert.equal(extracted.normalizedText, source);
  assert.equal(extracted.linkCount, 0);
});

test("单个视频分享中的多段说明保持为一项素材", () => {
  const source = "这是分享说明。\n\nhttps://v.douyin.com/abc123/\n\n这是补充说明。";
  const extracted = extractRewriteSourceMaterial(source);

  assert.equal(extracted.materials.length, 1);
  assert.equal(extracted.linkCount, 1);
  assert.match(extracted.materials[0].text, /这是分享说明。\n\n这是补充说明。/);
});

test("多个视频分享按链接边界拆成独立素材", () => {
  const source = [
    "第一条分享说明。\nhttps://v.douyin.com/abc123/",
    "第二条分享说明。\nhttps://v.douyin.com/xyz456/"
  ].join("\n\n");
  const extracted = extractRewriteSourceMaterial(source);

  assert.equal(extracted.materials.length, 2);
  assert.equal(extracted.linkCount, 2);
  assert.equal(extracted.materials[0].text, "第一条分享说明。");
  assert.equal(extracted.materials[1].text, "第二条分享说明。");
});

test("多个视频分享只隔一个换行时也会拆成独立素材", () => {
  const source = [
    "第一条分享说明。 https://v.douyin.com/abc123/",
    "第二条分享说明。 https://v.douyin.com/xyz456/"
  ].join("\n");
  const extracted = extractRewriteSourceMaterial(source);

  assert.equal(extracted.materials.length, 2);
  assert.equal(extracted.linkCount, 2);
  assert.equal(extracted.materials[0].text, "第一条分享说明。");
  assert.equal(extracted.materials[1].text, "第二条分享说明。");
});

test("支持文档链接分流时不压缩纯文字排版", () => {
  const source = "第一段保留  双空格。\n\n  第二段保留缩进。\n\nhttps://example.com/reference";
  const separated = splitWriterSourceInput(source);

  assert.equal(separated.sourceText, "第一段保留  双空格。\n\n  第二段保留缩进。");
  assert.equal(separated.supportDocLinks, "https://example.com/reference");
  assert.equal(separated.supportDocumentCount, 1);
});

test("已成功读取的支持文档会跨写作风格复用缓存", async () => {
  await withTemporaryLibrary(async () => {
    const url = "https://example.com/merchant-brief#section";
    const feishuRef = "docxcnCacheReuse123456";
    await writeSupportDocumentCache({
      url,
      provider: "web",
      title: "商单说明",
      content: "这是已读取的商单支持文档正文。"
    });
    await writeSupportDocumentCache({
      url: feishuRef,
      provider: "feishu",
      title: "飞书商单说明",
      content: "这是用文档标识读取过的飞书正文。"
    });

    const webDocuments = await fetchSupportDocuments(url);
    assert.deepEqual(webDocuments, [{
      url,
      provider: "web",
      title: "商单说明",
      content: "这是已读取的商单支持文档正文。"
    }]);
    const [firstStyle, secondStyle] = await Promise.all([
      upsertAccount({ platform: "bilibili", name: "缓存风格一", uid: "support-cache-style-1" }),
      upsertAccount({ platform: "douyin", name: "缓存风格二", uid: "support-cache-style-2" })
    ]);
    const contexts = await Promise.all([firstStyle, secondStyle].map((account) => prepareWriteCopyContext({
      styleRefs: [{ targetType: "account", platform: account.platform, accountId: account.id }],
      mode: "topic",
      prompt: "基于同一份商单资料生成文案",
      supportDocLinks: url
    })));
    assert.match(contexts[0].messages[1].content, /这是已读取的商单支持文档正文/);
    assert.match(contexts[1].messages[1].content, /这是已读取的商单支持文档正文/);

    const feishuDocuments = await fetchSupportDocuments(feishuRef);
    assert.deepEqual(feishuDocuments, [{
      url: feishuRef,
      provider: "feishu",
      title: "飞书商单说明",
      content: "这是用文档标识读取过的飞书正文。"
    }]);
  });
});

test("旧写作历史恢复时会移除内部素材包装", () => {
  assert.equal(restoreWriterSourceInput({
    sourceText: "素材 1：\n第一段原文\n\n---\n\n素材 2：\n第二段原文",
    supportDocLinks: "https://example.com/support"
  }), "第一段原文\n\n第二段原文\n\nhttps://example.com/support");

  assert.equal(restoreWriterSourceInput({
    originalSourceInput: "原始输入\n\n\n保留三个换行",
    sourceText: "素材 1：\n处理后输入"
  }), "原始输入\n\n\n保留三个换行");
});

test("支持文档超限拒绝，部分读取失败不能继续生成", async () => {
  const links = Array.from({ length: 5 }, (_, index) => `https://example.com/brief-${index}`);
  await assert.rejects(fetchSupportDocuments(links.join("\n")), /一次最多读取 4 份支持文档/);
  await assert.rejects(fetchSupportDocuments(Array.from({ length: 5 }, (_, index) => `docxcnLimitTest${index}123456`).join("\n")), /一次最多读取 4 份支持文档/);
  await withTemporaryLibrary(async () => {
    for (const url of links.slice(0, 4)) await writeSupportDocumentCache({ url, provider: "web", content: "已缓存支持资料" });
    assert.equal((await fetchSupportDocuments(links.slice(0, 4).join("\n"))).length, 4);
    await assert.rejects(prepareWriteCopyContext({ platform: "douyin", accountId: "unused", mode: "topic", prompt: "写活动",
      supportDocLinks: `${links[0]}\nhttps://127.0.0.1/denied` }), /支持文档读取失败.*127\.0\.0\.1.*内网/);
  });
});

test("视频刷新会修复失效转写状态", async () => {
  await withTemporaryLibrary(async () => {
    const account = await upsertAccount({ platform: "bilibili", name: "测试账号", uid: "uid-stale" });
    const [saved] = await saveVideos(account, [{
      ...videoFixture(account, 100),
      transcriptStatus: "completed",
      transcriptPath: "/missing/transcript.txt",
      transcriptSource: "platform_subtitle"
    }]);

    assert.equal(saved.transcriptStatus, "not_started");
    assert.equal(saved.transcriptPath, undefined);
    assert.equal(saved.transcriptSource, undefined);
  });
});

test("视频统计刷新与转写并发时不会互相覆盖", async () => {
  await withTemporaryLibrary(async () => {
    const account = await upsertAccount({ platform: "bilibili", name: "并发账号", uid: "uid-concurrent" });
    await saveVideos(account, [videoFixture(account, 100)]);

    await Promise.all([
      saveTranscript({
        platform: account.platform,
        accountId: account.id,
        videoId: "video-1",
        text: "这是一份并发写入的转写稿。",
        source: "manual"
      }),
      saveVideos(account, [videoFixture(account, 200)])
    ]);

    const { video } = await getVideo(account.platform, account.id, "video-1");
    assert.equal(video.stats.views, 200);
    assert.equal(video.transcriptStatus, "completed");
    assert.ok(video.transcriptRevision);
    assert.equal(await readTranscript(account.platform, account.id, "video-1"), "这是一份并发写入的转写稿。");
  });
});

test("素材库修复模式只改安全元数据并保留备份", async () => {
  await withTemporaryLibrary(async (temporaryRoot) => {
    const accountRoot = path.join(temporaryRoot, "bilibili", "repair-account");
    const videoFile = path.join(accountRoot, "videos", "video-1.json");
    await fs.mkdir(path.join(accountRoot, "videos"), { recursive: true });
    await fs.writeFile(path.join(accountRoot, "account.json"), `${JSON.stringify({
      id: "bilibili:repair-account",
      platform: "bilibili",
      name: "修复测试",
      slug: "repair-account",
      uid: "repair-account",
      videoCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`);
    await fs.writeFile(videoFile, `${JSON.stringify({
      ...videoFixture({ id: "bilibili:repair-account", platform: "bilibili" } as Account, 100),
      transcriptStatus: "completed",
      transcriptPath: "/missing/transcript.txt",
      transcriptRevision: "stale-revision",
      transcriptSource: "platform_subtitle"
    }, null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts", "check-library-consistency.mjs"),
      "--repair"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, STYLE_LIBRARY_DIR: temporaryRoot }
    });
    const result = JSON.parse(stdout) as {
      issueCount: number;
      repairCount: number;
      repairs: Array<{ backup: string }>;
    };
    const repaired = JSON.parse(await fs.readFile(videoFile, "utf8")) as Video;

    assert.equal(result.issueCount, 0);
    assert.equal(result.repairCount, 1);
    assert.equal(repaired.transcriptStatus, "not_started");
    assert.equal(repaired.transcriptPath, undefined);
    assert.equal(repaired.transcriptRevision, undefined);
    assert.equal(repaired.transcriptSource, undefined);
    assert.equal((await fs.stat(result.repairs[0].backup)).isFile(), true);
  });
});

function chatConfig(overrides: Partial<ChatRuntimeConfig>): ChatRuntimeConfig {
  return {
    role: "primary",
    enabled: true,
    apiKey: "test-key",
    baseUrl: "",
    responsesUrl: "",
    chatCompletionsUrl: "",
    model: "test-model",
    wireApi: "auto",
    reasoningEffort: "none",
    chatCompletionReasoningEffort: "none",
    serviceTier: "",
    proxyUrl: "",
    ...overrides
  };
}

function videoFixture(account: Account, views: number): Video {
  return {
    id: "video-1",
    platform: account.platform,
    accountId: account.id,
    title: "测试视频",
    url: "https://www.bilibili.com/video/BV1test",
    stats: {
      views,
      likes: 10,
      comments: 2,
      favorites: 1,
      shares: 0
    },
    hotScore: 0,
    relativeViewRate: 1,
    transcriptStatus: "not_started",
    updatedAt: new Date().toISOString()
  };
}

async function withTemporaryLibrary(run: (temporaryRoot: string) => Promise<void>) {
  const previousRoot = process.env.STYLE_LIBRARY_DIR;
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "style-library-test-"));
  process.env.STYLE_LIBRARY_DIR = temporaryRoot;
  try {
    await run(temporaryRoot);
  } finally {
    if (previousRoot === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previousRoot;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
