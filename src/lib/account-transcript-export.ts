import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { getAccountDetail, readTranscript } from "./storage";
import type { Platform, VideoListItem } from "./types";

type TranscriptExportItem = {
  video: VideoListItem;
  transcript: string;
};

export type AccountTranscriptExport = {
  buffer: Buffer;
  fileName: string;
  transcriptCount: number;
};

export async function createAccountTranscriptDocx(
  platform: Platform,
  accountId: string,
  videoIds?: string[]
): Promise<AccountTranscriptExport> {
  const account = await getAccountDetail(platform, accountId);
  const selectedIds = videoIds?.length ? new Set(videoIds) : null;
  const videos = selectedIds ? account.videos.filter((video) => selectedIds.has(video.id)) : account.videos;
  if (selectedIds && videos.length !== selectedIds.size) {
    throw new Error("部分所选视频已不存在，请刷新列表后重试。");
  }
  const items = (
    await Promise.all(
      videos.map(async (video) => ({
        video,
        transcript: await readTranscript(platform, account.id, video.id)
      }))
    )
  ).filter((item): item is TranscriptExportItem => Boolean(item.transcript.trim()));

  if (!items.length) {
    throw new Error("这个账号还没有可导出的转写稿。");
  }

  const doc = new Document({
    creator: "账号风格库",
    description: `${account.name} 的全部转写稿导出`,
    title: `${account.name} 转写稿`,
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1080,
              right: 1080,
              bottom: 1080,
              left: 1080
            }
          }
        },
        children: items.flatMap((item, index) => buildTranscriptSection(item, index + 1, account.platform))
      }
    ]
  });

  return {
    buffer: await Packer.toBuffer(doc),
    fileName: `${safeFileName(account.name)}-${selectedIds ? "所选" : "全部"}转写稿.docx`,
    transcriptCount: items.length
  };
}

function buildTranscriptSection(item: TranscriptExportItem, index: number, platform: Platform) {
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: index > 1,
      spacing: { before: index > 1 ? 160 : 0, after: 180 },
      children: [
        new TextRun({
          text: `爆款${index}`,
          bold: true,
          size: 32
        })
      ]
    }),
    ...formatTranscript(item.transcript, platform).map(
      (line) =>
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: {
            after: platform === "douyin" ? 120 : 150,
            line: platform === "douyin" ? 320 : 380
          },
          children: [
            new TextRun({
              text: line,
              size: platform === "douyin" ? 24 : 23
            })
          ]
        })
    )
  ];
}

function formatTranscript(transcript: string, platform: Platform) {
  return platform === "douyin" ? formatDouyinTranscript(transcript) : formatBilibiliTranscript(transcript);
}

function formatDouyinTranscript(transcript: string) {
  return transcript
    .replace(/\r\n/g, "\n")
    .split(/\n+|(?<=[。！？!?])\s*/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatBilibiliTranscript(transcript: string) {
  const lines = transcript
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const paragraphs: string[] = [];
  let current = "";

  for (const rawLine of lines) {
    const line = trimEndingPunctuation(rawLine);
    const next = current ? `${current}，${line}` : line;
    if (next.length >= 90 || shouldBreakBilibiliParagraph(rawLine, current)) {
      paragraphs.push(withChineseEnding(next));
      current = "";
    } else {
      current = next;
    }
  }

  if (current) paragraphs.push(withChineseEnding(current));
  return paragraphs;
}

function shouldBreakBilibiliParagraph(line: string, current: string) {
  if (!current) return false;
  const trimmed = line.trim();
  return /[。！？!?]$/.test(trimmed) && current.length >= 40;
}

function trimEndingPunctuation(line: string) {
  return line.replace(/[。！？!?；;：:，,、]+$/g, "").trim();
}

function withChineseEnding(line: string) {
  if (/[。！？!?；;：:，,、）)”"》]$/.test(line)) return line;
  if (/^(为什么|怎么|是不是|难道|凭什么|谁|什么|哪|吗|呢|吧|问)/.test(line) || /吗$|呢$|么$/.test(line)) {
    return `${line}？`;
  }
  if (/^(不是|没想到|注意|要知道|但问题是|关键是|离谱|结果)/.test(line)) {
    return `${line}！`;
  }
  return `${line}。`;
}

function safeFileName(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "账号";
}
