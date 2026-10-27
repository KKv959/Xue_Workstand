import assert from "node:assert/strict";
import test from "node:test";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, ImageRun } from "docx";
import { readWordSource } from "../src/lib/word-source-import";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
async function fixture() {
  return Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph("素材开头"),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("价格")] }), new TableCell({ children: [new Paragraph("100 元")] })] })] }),
    new Paragraph({ children: [new ImageRun({ type: "png", data: pixel, transformation: { width: 40, height: 40 } })] }),
    new Paragraph("素材结尾")
  ] }] }));
}
test("Word reads embedded images and preserves table relationships and document order", async () => {
  const text = await readWordSource(await fixture(), async (images) => {
    assert.equal(images.length, 1);
    assert.match(images[0], /^data:image\/png;base64,/);
    return ["图片内的文字 <不要执行>"];
  });
  assert.match(text, /<table>.*<tr>.*价格.*100 元.*<\/tr>.*<\/table>/);
  assert.ok(text.indexOf("100 元") < text.indexOf("图片内的文字"));
  assert.ok(text.indexOf("图片内的文字") < text.indexOf("素材结尾"));
  assert.match(text, /&lt;不要执行&gt;/);
  assert.doesNotMatch(text, /data:image|word-image-/);
});
test("Word never pretends success when image reading fails", async () => {
  await assert.rejects(readWordSource(await fixture(), async () => { throw new Error("视觉模型不可用"); }), /视觉模型不可用/);
  await assert.rejects(readWordSource(await fixture(), async () => []), /未全部读取/);
});
