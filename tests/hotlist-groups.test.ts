import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDouyinHotlist } from "../src/lib/douyin-hotlist";
import { addDouyinHotlistAccountRef, deleteDouyinHotlistGroup, readDouyinHotlistWatchlist, recordDouyinHotlistRefresh, removeDouyinHotlistAccountRefs, saveDouyinHotlistGroup, upsertDouyinHotlistAccount } from "../src/lib/storage/douyin-hotlist";
import { buildHotlistHref, getHotlistGroupAccounts } from "../src/app/douyin-hotlist/_lib/douyin-hotlist-model";
import { POST } from "../src/app/api/douyin-hotlist/route";

test("热榜多分组：旧数据兼容、持久化、并发保护、移除同步、损坏可见", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hotlist-groups-"));
  const previous = process.env.STYLE_LIBRARY_DIR;
  process.env.STYLE_LIBRARY_DIR = root;
  try {
    assert.deepEqual((await getDouyinHotlist()).groups, []);
    const a = await upsertDouyinHotlistAccount({ platform: "douyin", name: "账号 A", uid: "a" });
    const b = await upsertDouyinHotlistAccount({ platform: "bilibili", name: "账号 B", uid: "b" });
    await addDouyinHotlistAccountRef(a.id);
    await addDouyinHotlistAccountRef(b.id);
    const first = await saveDouyinHotlistGroup({ name: " 科技 ", accountIds: [a.id, b.id], revision: 0 });
    const second = await saveDouyinHotlistGroup({ name: "重点", accountIds: [a.id], revision: 1 });
    await recordDouyinHotlistRefresh({ full: true, successful: true, changed: false });
    const snapshot = await getDouyinHotlist();
    assert.equal(snapshot.groupRevision, 2);
    assert.equal(first.name, "科技");
    assert.deepEqual(getHotlistGroupAccounts(snapshot.accounts, snapshot.groups!, first.id).map((account) => account.id), [a.id, b.id]);
    assert.deepEqual(getHotlistGroupAccounts(snapshot.accounts, snapshot.groups!, second.id).map((account) => account.id), [a.id]);
    assert.equal(getHotlistGroupAccounts(snapshot.accounts, snapshot.groups!, "all").length, 2);
    assert.deepEqual(getHotlistGroupAccounts(snapshot.accounts, snapshot.groups!, "missing"), []);
    await assert.rejects(saveDouyinHotlistGroup({ name: "科技", accountIds: [], revision: 2 }), /同名/);
    await assert.rejects(saveDouyinHotlistGroup({ name: " ", accountIds: [], revision: 2 }), /名称/);
    await assert.rejects(saveDouyinHotlistGroup({ name: "错误账号", accountIds: ["douyin-hotlist:missing"], revision: 2 }), /移出监控池/);
    const concurrent = await Promise.allSettled([
      saveDouyinHotlistGroup({ id: first.id, name: "科技资讯", accountIds: [b.id], revision: 2 }),
      saveDouyinHotlistGroup({ id: second.id, name: "重点监控", accountIds: [a.id], revision: 2 })
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.status, 409);
    await removeDouyinHotlistAccountRefs([a.id]);
    const after = await readDouyinHotlistWatchlist();
    assert.equal(after.groupRevision, 4);
    assert.ok(after.groups!.every((group) => !group.accountIds.includes(a.id)));
    const file = path.join(root, "douyin-hotlist/watchlist.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    assert.equal(data.schemaVersion, 1);
    const invalid = JSON.stringify({ ...data, groups: [{ ...first, accountIds: ["douyin-hotlist:missing"] }] });
    await writeFile(file, invalid);
    await assert.rejects(readDouyinHotlistWatchlist(), /格式损坏/);
    assert.equal(await readFile(file, "utf8"), invalid);
  } finally {
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("分组 API 返回中文校验错误与版本冲突", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hotlist-group-api-"));
  const previous = process.env.STYLE_LIBRARY_DIR;
  process.env.STYLE_LIBRARY_DIR = root;
  const post = (input: object) => POST(new Request("http://localhost/api/douyin-hotlist", { method: "POST", body: JSON.stringify({ action: "saveGroup", ...input }) }));
  try {
    assert.equal((await post({ name: "", accountIds: [], revision: 0 })).status, 400);
    assert.equal((await post({ name: "测试", accountIds: [] })).status, 400);
    const saved = await post({ name: "测试", accountIds: [], revision: 0 });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { groups: Array<{ name: string }> };
    assert.equal(savedBody.groups[0].name, "测试");
    const conflict = await post({ name: "另一个", accountIds: [], revision: 0 });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json() as { error: string };
    assert.match(conflictBody.error, /重载/);
  } finally {
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("分组 URL 与账号、平台、时间筛选共存，并可恢复全部", () => {
  const href = buildHotlistHref({ pathname: "/douyin-hotlist", search: "from=nav", account: "platform:douyin", group: "group-a", sort: "recent", window: "24h" });
  const params = new URL(href, "http://localhost").searchParams;
  assert.equal(params.get("group"), "group-a");
  assert.equal(params.get("account"), "platform:douyin");
  assert.equal(params.get("window"), "24h");
  assert.equal(params.get("from"), "nav");
  assert.equal(buildHotlistHref({ pathname: "/douyin-hotlist", search: params.toString(), account: "all", group: "all", sort: "likes", window: "3d" }), "/douyin-hotlist?from=nav");
});

test("删除分组保留账号和其他分组，拒绝过期版本及无效请求", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hotlist-group-delete-"));
  const previous = process.env.STYLE_LIBRARY_DIR;
  process.env.STYLE_LIBRARY_DIR = root;
  const post = (input: object) => POST(new Request("http://localhost/api/douyin-hotlist", { method: "POST", body: JSON.stringify({ action: "deleteGroup", ...input }) }));
  try {
    const account = await upsertDouyinHotlistAccount({ platform: "douyin", name: "保留账号", uid: "keep" });
    await addDouyinHotlistAccountRef(account.id);
    const group = await saveDouyinHotlistGroup({ name: "待删除", accountIds: [account.id], revision: 0 });
    const other = await saveDouyinHotlistGroup({ name: "保留分组", accountIds: [account.id], revision: 1 });
    const accountFile = path.join(root, "douyin-hotlist/accounts", account.slug, "account.json");
    const before = await readFile(accountFile, "utf8");
    assert.equal((await post({ groupId: group.id })).status, 400);
    assert.equal((await post({ groupId: "bad", revision: 2 })).status, 400);
    assert.equal((await post({ groupId: group.id, revision: 1 })).status, 409);
    assert.equal((await readDouyinHotlistWatchlist()).groups?.length, 2);
    const response = await post({ groupId: group.id, revision: 2 });
    assert.equal(response.status, 200);
    const result = await response.json() as { groups: typeof other[]; groupRevision: number };
    assert.deepEqual(result.groups, [other]);
    assert.equal(result.groupRevision, 3);
    assert.deepEqual((await readDouyinHotlistWatchlist()).accountIds, [account.id]);
    assert.equal(await readFile(accountFile, "utf8"), before);
    assert.equal((await post({ groupId: group.id, revision: 3 })).status, 404);
    await assert.rejects(saveDouyinHotlistGroup({ id: other.id, name: "旧版覆盖", accountIds: [], revision: 2 }), /重载/);
    await deleteDouyinHotlistGroup({ id: other.id, revision: 3 });
    assert.deepEqual((await getDouyinHotlist()).groups, []);
    assert.equal((await getDouyinHotlist()).accounts.length, 1);
  } finally {
    if (previous === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
