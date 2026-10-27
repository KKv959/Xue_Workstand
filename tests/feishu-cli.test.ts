import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchFeishuSupportDocuments, publishFeishuDocument } from "../src/lib/feishu";

test("飞书直接调用 Lark CLI，以新版参数和嵌套文档返回值读写", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lark-upgrade-test-"));
  const bin = path.join(root, "lark-cli");
  const previous = process.env.LARK_CLI_BIN;
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'docs' || args.includes('lark-cli') || args.includes('--api-version') || args.includes('--markdown')) process.exit(2);
if (args[1] === '+create') {
  if (!args.includes('--content') || !args.includes('--doc-format')) process.exit(3);
  let body = ''; for await (const chunk of process.stdin) body += chunk;
  if (body !== '测试正文') process.exit(4);
  console.log(JSON.stringify({ok:true,data:{document:{document_id:'fixture',url:'https://example.feishu.cn/docx/fixture'}}}));
} else console.log(JSON.stringify({ok:true,data:{document:{title:'测试标题',content:'测试正文'}}}));
`, { mode: 0o755 });
  process.env.LARK_CLI_BIN = bin;
  try {
    const docs = await fetchFeishuSupportDocuments("https://example.feishu.cn/docx/fixture");
    assert.equal(docs[0]?.content, "测试正文");
    const created = await publishFeishuDocument({ title: "测试标题", content: "测试正文" });
    assert.equal(created.documentId, "fixture");
    assert.equal(created.url, "https://example.feishu.cn/docx/fixture");
  } finally {
    if (previous === undefined) delete process.env.LARK_CLI_BIN;
    else process.env.LARK_CLI_BIN = previous;
    await rm(root, { recursive: true, force: true });
  }
});
