export type WriterSourceItem = {
  kind: "file" | "text" | "link";
  title: string;
  content: string;
  raw: string;
  start: number;
  end: number;
  truncated?: boolean;
};

// Display existing source input without rewriting its persisted representation.
// Incomplete or nested file markers remain ordinary text to avoid losing content.
export function splitWriterSourceItems(value: string): WriterSourceItem[] {
  const items: WriterSourceItem[] = [];
  const blocks = /^===== 本地文件：([^\r\n]+) =====\r?\n([\s\S]*?)^===== 文件结束 =====[\t ]*(?=\r?$)/gm;
  let cursor = 0;
  const pushText = (start: number, end: number) => {
    const raw = value.slice(start, end);
    const content = raw.trim();
    if (!content) return;
    const linkOnly = /^https?:\/\/\S+$/.test(content);
    items.push({ kind: linkOnly ? "link" : "text", title: linkOnly ? content : content.split(/\r?\n/)[0].slice(0, 60), raw, content, start, end });
  };
  const addText = (start: number, end: number) => {
    let textStart = start;
    for (const link of value.slice(start, end).matchAll(/^[\t ]*https?:\/\/\S+[\t ]*(?=\r?$)/gm)) {
      const linkStart = start + link.index;
      pushText(textStart, linkStart);
      textStart = linkStart + link[0].length;
      pushText(linkStart, textStart);
    }
    pushText(textStart, end);
  };
  for (const match of value.matchAll(blocks)) {
    if (/^===== 本地文件：/m.test(match[2])) continue;
    addText(cursor, match.index);
    const end = match.index + match[0].length;
    items.push({ kind: "file", title: match[1], content: match[2].replace(/\r?\n$/, ""), raw: match[0], start: match.index, end, truncated: match[1].endsWith("（已截取前 40000 字）") });
    cursor = end;
  }
  addText(cursor, value.length);
  return items;
}
