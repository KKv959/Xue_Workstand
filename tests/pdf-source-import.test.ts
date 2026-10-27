import assert from "node:assert/strict";
import test from "node:test";
import { readPdfSource } from "../src/lib/pdf-source-import";

function pdfWithContent(content: string) {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Count 1/Kids[3 0 R]>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"
  ];
  return Buffer.from(`%PDF-1.4\n${objects.map((object, index) => `${index + 1} 0 obj${object}endobj\n`).join("")}trailer<</Root 1 0 R>>\n%%EOF`);
}

test("PDF extracts its text layer", async () => {
  const text = await readPdfSource(pdfWithContent("BT /F1 12 Tf 20 100 Td (PDF test text) Tj ET"));
  assert.match(text, /PDF test text/);
  assert.match(text, /已读取 1 页/);
});

test("PDF without a text layer fails with an OCR hint", async () => {
  await assert.rejects(readPdfSource(pdfWithContent("q 0 0 10 10 re f Q")), /扫描件请先进行 OCR/);
});
