import { readWordSource } from "@/lib/word-source-import";
import { readPdfSource } from "@/lib/pdf-source-import";
import { readDocumentImages } from "@/lib/ai";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-route";
import type { WriterSourceFileImport } from "@/lib/types";

export const runtime = "nodejs";

const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 40_000;
const TEXT_EXTENSIONS = new Set([
  "csv",
  "htm",
  "html",
  "json",
  "log",
  "markdown",
  "md",
  "srt",
  "txt",
  "vtt",
  "xml",
  "yaml",
  "yml"
]);

class WriterFileInputError extends Error {
  readonly status = 400;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files").filter((item): item is File => item instanceof File);
    if (!files.length) throw new WriterFileInputError("请选择至少一个文件");
    if (files.length > MAX_FILES) throw new WriterFileInputError(`一次最多导入 ${MAX_FILES} 个文件`);

    let totalBytes = 0;
    for (const file of files) {
      if (!file.size) throw new WriterFileInputError(`文件内容为空：${file.name || "未命名文件"}`);
      if (file.size > MAX_FILE_BYTES) throw new WriterFileInputError(`单个文件不能超过 10MB：${file.name || "未命名文件"}`);
      totalBytes += file.size;
    }
    if (totalBytes > MAX_TOTAL_BYTES) throw new WriterFileInputError("本次导入文件总大小不能超过 40MB");

    const importedFiles: WriterSourceFileImport[] = [];
    for (const file of files) {
      importedFiles.push(await extractSourceFile(file, request.signal));
    }
    return NextResponse.json({ files: importedFiles });
  } catch (error) {
    return apiError(error, { fallbackMessage: "导入素材文件失败" });
  }
}

async function extractSourceFile(file: File, signal?: AbortSignal): Promise<WriterSourceFileImport> {
  const extension = getExtension(file.name);
  let text = "";

  if (extension === "pdf") {
    try {
      text = await readPdfSource(Buffer.from(await file.arrayBuffer()), signal);
    } catch (error) {
      throw new WriterFileInputError(`无法读取 PDF「${file.name || "未命名文件"}」：${error instanceof Error ? error.message : "请确认文件没有损坏"}`);
    }
  } else if (extension === "docx") {
    try {
      text = await readWordSource(Buffer.from(await file.arrayBuffer()), readDocumentImages, signal);
    } catch (error) {
      throw new WriterFileInputError(`无法完整读取 Word「${file.name || "未命名文件"}」：${error instanceof Error ? error.message : "请确认文件没有损坏"}`);
    }
  } else if (TEXT_EXTENSIONS.has(extension)) {
    text = await file.text();
  } else {
    throw new WriterFileInputError(`不支持的文件格式：${file.name || "未命名文件"}`);
  }

  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\0/g, "").trim();
  if (!normalized) throw new WriterFileInputError(`没有从文件中读取到正文：${file.name || "未命名文件"}`);

  return {
    name: file.name || `未命名.${extension}`,
    mimeType: file.type || (extension === "pdf" ? "application/pdf" : extension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain"),
    text: extension === "docx" ? normalized : normalized.slice(0, MAX_TEXT_CHARACTERS),
    originalCharacters: normalized.length,
    truncated: extension !== "docx" && normalized.length > MAX_TEXT_CHARACTERS
  };
}

function getExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
}
