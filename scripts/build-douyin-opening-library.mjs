import { promises as fs } from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const douyinRoot = path.join(workspaceRoot, "style-library", "douyin");
const outputRoot = path.join(workspaceRoot, "style-library", "opening-library");
const jsonOutputPath = path.join(outputRoot, "douyin-openings.json");
const markdownOutputPath = path.join(outputRoot, "douyin-openings.md");
const readmeOutputPath = path.join(outputRoot, "README.md");

const collator = new Intl.Collator("zh-CN", { numeric: true });

function normalizeTranscript(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function splitSentences(text) {
  const flattened = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  const matches = flattened.match(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$/g) ?? [];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function clipText(text, maxLength) {
  if (text.length <= maxLength) return { text, truncated: false };
  return { text: `${text.slice(0, maxLength).trimEnd()}…`, truncated: true };
}

function extractOpening(transcript) {
  const sentences = splitSentences(transcript);
  if (!sentences.length) {
    return { hook: "", opening: "", openingSentenceCount: 0, truncated: false };
  }

  const hook = clipText(sentences[0], 100).text;
  const selected = [];
  let characterCount = 0;

  for (const sentence of sentences.slice(0, 3)) {
    if (selected.length && characterCount >= 80) break;
    if (selected.length && characterCount + sentence.length > 180) break;
    selected.push(sentence);
    characterCount += sentence.length;
  }

  if (!selected.length) selected.push(sentences[0]);
  const clipped = clipText(selected.join("\n"), 180);

  return {
    hook,
    opening: clipped.text,
    openingSentenceCount: selected.length,
    truncated: clipped.truncated || selected.length < Math.min(sentences.length, 3)
  };
}

function classifyOpening(hook) {
  if (/[？?]/u.test(hook)) return "提问悬念";
  if (/辱骂|背刺|网暴|暴揍|被封|争议|爆雷|死刑|翻车|惨遭|拒绝/u.test(hook)) return "冲突争议";
  if (/没想到|想不到|竟然|居然|不可能|反而|却|只靠|画风一转/u.test(hook)) return "反差意外";
  if (/终于|来了|赢得|拿下|被捕|宣布|正式|真结局|史上/u.test(hook)) return "结果前置";
  if (/史上最|最.{0,12}(?:的|一)|唯一|只有|绝对|一定|真正|可能是/u.test(hook)) return "强结论";
  return "场景直入";
}

function relativePath(filePath) {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function formatDate(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function escapeMarkdown(text) {
  return text.replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, "\\$1");
}

function buildMarkdown(library) {
  const grouped = new Map();
  for (const entry of library.entries) {
    const key = `${entry.account.id}\u0000${entry.account.name}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }

  const lines = [
    "# 抖音开头库",
    "",
    `共 ${library.totalEntries} 条开头，来自 ${library.accountCount} 个抖音账号。更新时间：${formatDate(library.generatedAt)}。`,
    "",
    "> 每条包含第一句“钩子句”和前 1–3 句“完整开头”。内容来自已完成转写稿，原稿未被修改。",
    ""
  ];

  const groups = [...grouped.entries()].sort(([, left], [, right]) =>
    collator.compare(left[0].account.name, right[0].account.name)
  );

  for (const [, entries] of groups) {
    const account = entries[0].account;
    lines.push(`## ${escapeMarkdown(account.name)}（${entries.length}）`, "");

    for (const [index, entry] of entries.entries()) {
      const title = escapeMarkdown(entry.video.title || `视频 ${entry.video.id}`);
      const titleLine = entry.video.url
        ? `### ${index + 1}. [${title}](${entry.video.url})`
        : `### ${index + 1}. ${title}`;
      lines.push(
        titleLine,
        "",
        `- 类型：${entry.openingType}`,
        `- 发布：${formatDate(entry.video.publishedAt)} · 点赞 ${formatNumber(entry.video.stats.likes)} · 评论 ${formatNumber(entry.video.stats.comments)} · 收藏 ${formatNumber(entry.video.stats.favorites)}`,
        `- 视频 ID：\`${entry.video.id}\``,
        "",
        `**钩子句：** ${entry.hook}`,
        "",
        entry.opening
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
        ""
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function buildLibrary() {
  const accountSlugs = await fs.readdir(douyinRoot);
  const entries = [];

  for (const accountSlug of accountSlugs.sort(collator.compare)) {
    const accountRoot = path.join(douyinRoot, accountSlug);
    const accountPath = path.join(accountRoot, "account.json");
    const transcriptRoot = path.join(accountRoot, "transcripts");

    let account;
    let transcriptNames;
    try {
      account = await readJson(accountPath);
      transcriptNames = await fs.readdir(transcriptRoot);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }

    for (const transcriptName of transcriptNames.filter((name) => name.endsWith(".txt")).sort(collator.compare)) {
      const videoId = transcriptName.slice(0, -4);
      const transcriptPath = path.join(transcriptRoot, transcriptName);
      const videoPath = path.join(accountRoot, "videos", `${videoId}.json`);
      const [video, rawTranscript] = await Promise.all([
        readJson(videoPath),
        fs.readFile(transcriptPath, "utf8")
      ]);

      if (video.transcriptStatus !== "completed") continue;
      const transcript = normalizeTranscript(rawTranscript);
      if (!transcript) continue;
      const extracted = extractOpening(transcript);

      entries.push({
        id: `douyin:${account.slug}:${video.id}`,
        platform: "douyin",
        account: {
          id: account.id,
          slug: account.slug,
          name: account.name,
          sourceUrl: account.sourceUrl ?? ""
        },
        video: {
          id: video.id,
          title: video.title,
          url: video.url,
          publishedAt: video.publishedAt ?? "",
          stats: {
            views: Number(video.stats?.views) || 0,
            likes: Number(video.stats?.likes) || 0,
            comments: Number(video.stats?.comments) || 0,
            favorites: Number(video.stats?.favorites) || 0,
            shares: Number(video.stats?.shares) || 0
          }
        },
        openingType: classifyOpening(extracted.hook),
        hook: extracted.hook,
        opening: extracted.opening,
        openingSentenceCount: extracted.openingSentenceCount,
        truncated: extracted.truncated,
        sourceTranscriptPath: relativePath(transcriptPath)
      });
    }
  }

  entries.sort((left, right) => {
    const accountOrder = collator.compare(left.account.name, right.account.name);
    if (accountOrder) return accountOrder;
    const publishedOrder = (right.video.publishedAt || "").localeCompare(left.video.publishedAt || "");
    if (publishedOrder) return publishedOrder;
    return collator.compare(left.video.id, right.video.id);
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    platform: "douyin",
    sourceRoot: relativePath(douyinRoot),
    accountCount: new Set(entries.map((entry) => entry.account.id)).size,
    totalEntries: entries.length,
    extractionRule: "第一句作为钩子；完整开头取前 1–3 句，达到 80 字即停止，最多 180 字。",
    entries
  };
}

const library = await buildLibrary();
await fs.mkdir(outputRoot, { recursive: true });
await Promise.all([
  writeAtomic(jsonOutputPath, `${JSON.stringify(library, null, 2)}\n`),
  writeAtomic(markdownOutputPath, buildMarkdown(library)),
  writeAtomic(
    readmeOutputPath,
    `# 开头库\n\n这里保存从现有已完成转写稿派生的开头素材。\n\n- \`douyin-openings.md\`：适合直接阅读、搜索和复制。\n- \`douyin-openings.json\`：保留账号、视频、互动数据和原转写路径，方便后续接入页面或二次分析。\n- 原始转写稿不会被修改。\n- 重新生成：在项目根目录执行 \`node scripts/build-douyin-opening-library.mjs\`。\n- 生成文件会整体刷新，不要在其中手工维护内容。\n`
  )
]);

console.log(`已生成抖音开头库：${library.totalEntries} 条，${library.accountCount} 个账号。`);
console.log(relativePath(markdownOutputPath));
console.log(relativePath(jsonOutputPath));
