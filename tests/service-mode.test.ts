import assert from "node:assert/strict";
import test from "node:test";
import { getServiceModeStatus, isLocalServiceRequest, serviceModeCommand, serviceModePlist, switchServiceMode } from "../src/lib/service-mode";

test("服务控制只接受本机 3000 页面，拒绝跨站、资料桥和其他端口", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const url = `http://${host}:3000/api/remote/service-mode`;
    assert.equal(isLocalServiceRequest(new Request(url)), true);
    assert.equal(isLocalServiceRequest(new Request(url, { method: "POST", headers: { origin: `http://${host}:3000` } })), true);
    assert.equal(isLocalServiceRequest(new Request(url, { method: "POST" })), false);
    assert.equal(isLocalServiceRequest(new Request(url, { method: "POST", headers: { origin: "https://example.com" } })), false);
    assert.equal(isLocalServiceRequest(new Request(url, { headers: { "x-workspace-app-mode": "workspace" } })), false);
  }
  for (const url of ["http://localhost:3002/api/remote/service-mode", "https://example.com/api/remote/service-mode"]) {
    assert.equal(isLocalServiceRequest(new Request(url)), false);
  }
});

test("切换参数不经过 shell，只调用现有 dev/start，不触发发布", () => {
  const root = "/tmp/project with spaces/$(danger)`test`";
  for (const [mode, command] of [["development", "dev"], ["production", "start"]] as const) {
    assert.deepEqual(serviceModeCommand(root, mode), ["/usr/bin/env", `WORKBENCH_SOURCE_ROOT=${root}`,
      `PATH=${process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"}`,
      process.execPath, `${root}/scripts/remote-server.mjs`, command]);
  }
});

test("隔离服务显式禁止切换，不能操作正式服务", async () => {
  const previous = process.env.WORKSPACE_DEV_SANDBOX;
  process.env.WORKSPACE_DEV_SANDBOX = "1";
  try {
    const request = new Request("http://localhost:3000/api/remote/service-mode", {
      method: "POST", headers: { origin: "http://localhost:3000" }
    });
    const status = await getServiceModeStatus(request);
    assert.equal(status.available, false);
    assert.match(status.reason || "", /隔离测试/);
    await assert.rejects(switchServiceMode(request, "production"), { status: 403 });
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_DEV_SANDBOX;
    else process.env.WORKSPACE_DEV_SANDBOX = previous;
  }
});

test("切换任务只运行一次，路径中的 XML 字符正确转义", () => {
  const plist = serviceModePlist("/tmp/project <a&b>", "development");
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /project &lt;a&amp;b&gt;/);
  assert.ok(!plist.includes("project <a&b>"));
});
