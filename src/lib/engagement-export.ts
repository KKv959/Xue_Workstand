import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun } from "docx";
import { extractBvid, extractDouyinAwemeId, getVideoComparableKey } from "./platform-links";
import { getGrossMarginMonitorRecords, resolveEngagementRecord } from "./storage";
import { resolveLinkSourceAccountName } from "./transcription";

export type EngagementExport = {
  buffer: Buffer;
  fileName: string;
};

const DOCUMENT_FONT = {
  ascii: "Arial Unicode MS",
  hAnsi: "Arial Unicode MS",
  eastAsia: "Arial Unicode MS",
  cs: "Arial Unicode MS"
};

export async function createEngagementDocx(recordId: string): Promise<EngagementExport> {
  const record = await resolveEngagementRecord(recordId);
  const fileBaseName = await resolveExportAccountName(record);
  const comments = record.comments?.items.map((item) => item.text.trim()).filter(Boolean) || [];
  const danmaku = record.danmaku?.items.map((item) => item.text.trim()).filter(Boolean) || [];
  const sourceUrl = record.sourceUrl?.trim() || record.resolvedUrl?.trim() || "";

  if (!comments.length && !danmaku.length) {
    throw new Error("这条记录还没有可导出的评论或弹幕。");
  }

  const documentTitle = `${fileBaseName}｜${comments.length} 条评论｜${danmaku.length} 条弹幕`;

  const doc = new Document({
    creator: "账号风格库",
    description: `${fileBaseName} 的评论与弹幕导出`,
    title: documentTitle,
    styles: {
      default: {
        document: {
          run: { font: DOCUMENT_FONT, size: 22 },
          paragraph: { spacing: { line: 320, after: 100 } }
        }
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: DOCUMENT_FONT, size: 28, bold: true, color: "111827" },
          paragraph: { spacing: { before: 220, after: 120 }, outlineLevel: 0 }
        }
      ]
    },
    numbering: {
      config: [
        buildNumberingConfig("comments"),
        buildNumberingConfig("danmaku")
      ]
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: 11906,
              height: 16838
            },
            margin: {
              top: 1080,
              right: 1080,
              bottom: 1080,
              left: 1080
            }
          }
        },
        children: [
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun({ text: fileBaseName, bold: true, size: 34, font: DOCUMENT_FONT })
            ]
          }),
          new Paragraph({
            spacing: { after: 80 },
            children: [
              new TextRun({ text: `${comments.length} 条评论｜${danmaku.length} 条弹幕`, color: "475467", font: DOCUMENT_FONT })
            ]
          }),
          ...(sourceUrl
            ? [
                new Paragraph({
                  spacing: { after: 260 },
                  children: [new TextRun({ text: sourceUrl, font: DOCUMENT_FONT })]
                })
              ]
            : []),
          ...buildNumberedSection("评论", comments, "comments"),
          ...buildNumberedSection("弹幕", danmaku, "danmaku")
        ]
      }
    ]
  });

  return {
    buffer: await Packer.toBuffer(doc),
    fileName: `${safeFileName(fileBaseName)}+${comments.length}条评论+${danmaku.length}条弹幕.docx`
  };
}

async function resolveExportAccountName(record: Awaited<ReturnType<typeof resolveEngagementRecord>>) {
  const existing = record.sourceAccountName?.trim();
  if (existing) return existing;

  const localAccountName = await resolveLocalMonitorAccountName(record).catch(() => "");
  if (localAccountName) return localAccountName;

  if (record.platform === "douyin" || record.platform === "bilibili") {
    for (const url of getRecordCandidateUrls(record)) {
      const accountName = await resolveLinkSourceAccountName(url).catch(() => "");
      if (accountName) return accountName;
    }
  }

  return record.title.trim() || "数据维护";
}

async function resolveLocalMonitorAccountName(record: Awaited<ReturnType<typeof resolveEngagementRecord>>) {
  const recordKeys = buildMonitorMatchKeys(record.sourceUrl, record.resolvedUrl);
  if (!recordKeys.size) return "";

  const records = await getGrossMarginMonitorRecords();
  const matched = records.find((item) => {
    if (!item.accountName?.trim()) return false;
    return hasSharedKey(recordKeys, buildMonitorMatchKeys(item.videoUrl, item.videoKey));
  });

  return matched?.accountName?.trim() || "";
}

function getRecordCandidateUrls(record: Awaited<ReturnType<typeof resolveEngagementRecord>>) {
  return uniqueStrings([record.resolvedUrl, record.sourceUrl]);
}

function buildMonitorMatchKeys(...values: Array<string | undefined>) {
  const keys = new Set<string>();
  for (const value of values) {
    const input = value?.trim();
    if (!input) continue;

    if (isStableMonitorKey(input)) keys.add(input.toLowerCase());

    const bvid = extractBvid(input);
    if (bvid) keys.add(`bilibili:${bvid.toUpperCase()}`);

    const awemeId = extractDouyinAwemeId(input);
    if (awemeId) keys.add(`douyin:${awemeId}`);

    const comparableKey = getVideoComparableKey(input);
    if (isStableMonitorKey(comparableKey)) keys.add(comparableKey.toLowerCase());

    const urlKey = normalizeUrlKey(input);
    if (urlKey) keys.add(urlKey);
  }
  return keys;
}

function isStableMonitorKey(value: string) {
  return /^douyin:\d{10,}$/i.test(value) || /^bilibili:BV[0-9A-Za-z]+$/i.test(value);
}

function hasSharedKey(left: Set<string>, right: Set<string>) {
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

function normalizeUrlKey(value?: string) {
  const input = value?.trim();
  if (!input) return "";
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/$/, "");
    const searchKey = getStableSearchKey(parsed.searchParams);
    if (!pathname && !searchKey) return "";
    if (pathname === "/" && !searchKey) return "";
    if (searchKey) return `${host}${pathname}?${searchKey}`.toLowerCase();
    return `${host}${pathname}`.toLowerCase();
  } catch {
    const normalized = input.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "").toLowerCase();
    return normalized.includes("/") ? normalized : "";
  }
}

function getStableSearchKey(searchParams: URLSearchParams) {
  for (const key of ["bvid", "aid", "aweme_id", "modal_id", "item_id"]) {
    const value = searchParams.get(key)?.trim();
    if (value) return `${key}=${value}`;
  }
  return "";
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim() || "").filter(Boolean))];
}

function buildNumberedSection(title: string, items: string[], numberingReference: "comments" | "danmaku") {
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `${title}（${items.length}）`, bold: true, size: 28, font: DOCUMENT_FONT })]
    }),
    ...(items.length
      ? items.map(
          (item) =>
            new Paragraph({
              spacing: { after: 90, line: 320 },
              numbering: { reference: numberingReference, level: 0 },
              children: [
                new TextRun({
                  text: item,
                  size: 22,
                  font: DOCUMENT_FONT
                })
              ]
            })
        )
      : [
          new Paragraph({
            spacing: { after: 90 },
            children: [new TextRun({ text: "无", color: "667085", size: 22, font: DOCUMENT_FONT })]
          })
        ])
  ];
}

function buildNumberingConfig(reference: "comments" | "danmaku") {
  return {
    reference,
    levels: [
      {
        level: 0,
        format: LevelFormat.DECIMAL,
        text: "%1.",
        alignment: AlignmentType.LEFT,
        style: {
          paragraph: {
            indent: { left: 560, hanging: 360 }
          }
        }
      }
    ]
  };
}

function safeFileName(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "数据维护";
}
