import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/support-documents.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("support-documents.ts", source, ts.ScriptTarget.Latest, true);
const names = ["fetchWithTimeout", "readJsonObject", "throwIfAborted", "parseJson", "asObject"];
const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ""))
  .map(node => node.getText(ast)).join("\n");
const { fetchWithTimeout, readJsonObject } = vm.runInNewContext(
  ts.transpile(code, { target: ts.ScriptTarget.ES2022 }) + "\n({ fetchWithTimeout, readJsonObject })",
  { fetch, AbortController, setTimeout, clearTimeout, REMOTE_FETCH_TIMEOUT_MS: 150 }
) as {
  fetchWithTimeout: <T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>, signal?: AbortSignal) => Promise<T>;
  readJsonObject: (response: Response, message: string) => Promise<Record<string, unknown>>;
};

test("支持文档在响应头之后取消或超时，正文读取与底层连接一起终止", async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    let bodyStarted!: () => void;
    const ready = new Promise<void>(resolve => { bodyStarted = resolve; });
    let bodyClosed!: () => void;
    const closed = new Promise<void>(resolve => { bodyClosed = resolve; });
    const server = createServer((_request, response) => {
      response.on("close", bodyClosed);
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"content":"');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const controller = new AbortController();
    try {
      const pending = fetchWithTimeout(`http://127.0.0.1:${address.port}`, {}, response => {
        const reading = readJsonObject(response, "正文读取失败");
        bodyStarted();
        return reading;
      }, controller.signal);
      const rejected = assert.rejects(pending, mode === "cancel" ? /任务已停止/ : /文档服务响应超时/);
      await Promise.race([ready, pending]);
      if (mode === "cancel") controller.abort();
      await rejected;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("正文连接取消后未关闭")), 2_000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test("支持文档正常 JSON 可解析，HTTP 和正文解析错误保持显式失败", async () => {
  assert.equal((await readJsonObject(Response.json({ content: "正文" }), "读取失败")).content, "正文");
  await assert.rejects(readJsonObject(new Response("拒绝访问", { status: 403 }), "读取失败"), /读取失败（HTTP 403）/);
  await assert.rejects(readJsonObject(new Response("not-json"), "读取失败"), /返回内容无法解析/);
});
