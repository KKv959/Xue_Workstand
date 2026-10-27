import type { WriterSourceFileImport } from "./types";

export const WRITER_SOURCE_FILE_ACCEPT = ".txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.srt,.vtt,.log,.yaml,.yml,.docx,.pdf";

export function appendWriterSourceFiles(current: string, files: WriterSourceFileImport[]) {
  const fileBlocks = files.map((file) => {
    const safeName = file.name.replace(/[\r\n]+/g, " ").trim() || "未命名文件";
    const truncationLabel = file.truncated ? "（已截取前 40000 字）" : "";
    return `===== 本地文件：${safeName}${truncationLabel} =====\n${file.text}\n===== 文件结束 =====`;
  });
  return [current.trimEnd(), ...fileBlocks].filter(Boolean).join("\n\n");
}

export function countWriterSourceFiles(value: string) {
  return value.match(/^===== 本地文件：.+ =====$/gm)?.length || 0;
}
