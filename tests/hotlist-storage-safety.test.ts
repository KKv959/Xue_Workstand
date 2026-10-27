import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDouyinHotlist } from "../src/lib/douyin-hotlist";
import { addDouyinHotlistAccountRef, getDouyinHotlistAccountVideos, readDouyinHotlistWatchlist, resolveDouyinHotlistAccount, upsertDouyinHotlistAccount, withDouyinHotlistMutationLock } from "../src/lib/storage/douyin-hotlist";

test("热榜只读不迁移、同名账号隔离、旧目录稳定、watchlist 串行且损坏可见", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hotlist-safety-"));
  const previousRoot = process.env.STYLE_LIBRARY_DIR;
  process.env.STYLE_LIBRARY_DIR = root;
  try {
    assert.equal((await getDouyinHotlist()).accounts.length, 0);
    assert.deepEqual(await readdir(root), [], "首次 GET 不创建目录");
    const [a, b] = await Promise.all(["uid-a", "uid-b"].map(uid => withDouyinHotlistMutationLock(() => upsertDouyinHotlistAccount({ platform: "douyin", name: "同名", uid }))));
    assert.notEqual(a.slug, b.slug);
    assert.equal((await resolveDouyinHotlistAccount(a.id))?.uid, "uid-a");
    assert.equal((await resolveDouyinHotlistAccount(b.id))?.uid, "uid-b");
    const oldSlug = "douyin-old";
    await mkdir(path.join(root, "douyin-hotlist/accounts", oldSlug));
    await writeFile(path.join(root, "douyin-hotlist/accounts", oldSlug, "account.json"), JSON.stringify({ ...a, uid: "old-uid", id: `douyin-hotlist:${oldSlug}`, slug: oldSlug }));
    const old = await withDouyinHotlistMutationLock(() => upsertDouyinHotlistAccount({ platform: "douyin", name: "改名", uid: "old-uid" }));
    assert.equal(old.slug, oldSlug);
    assert.deepEqual(await getDouyinHotlistAccountVideos(old), []);
    assert.deepEqual(await readdir(path.join(root, "douyin-hotlist/accounts", oldSlug)), ["account.json", "videos"]);
    await Promise.all([a.id, b.id, old.id].map(addDouyinHotlistAccountRef));
    assert.equal((await readDouyinHotlistWatchlist()).accountIds.length, 3);
    const watchlistPath = path.join(root, "douyin-hotlist/watchlist.json");
    const legacy = JSON.stringify({ version: 1, accountIds: ["douyin:legacy"], updatedAt: new Date().toISOString() });
    await writeFile(watchlistPath, legacy);
    assert.deepEqual((await readDouyinHotlistWatchlist()).accountIds, ["douyin:legacy"]);
    await assert.rejects(getDouyinHotlist(), /显式迁移/);
    assert.equal(await readFile(watchlistPath, "utf8"), legacy);
    await writeFile(watchlistPath, JSON.stringify({ version: 1, accountIds: [a.id], updatedAt: new Date().toISOString() }));
    const accountPath = path.join(root, "douyin-hotlist/accounts", a.slug, "account.json");
    await writeFile(accountPath, "{}");
    await assert.rejects(getDouyinHotlist(), /结构无效/);
    await writeFile(accountPath, "{bad");
    await assert.rejects(getDouyinHotlist(), /JSON 文件损坏/);
    await rm(accountPath);
    assert.deepEqual((await getDouyinHotlist()).summary.staleAccountIds, [a.id]);
    await writeFile(watchlistPath, JSON.stringify({ version: 1, accountIds: "bad" }));
    await assert.rejects(readDouyinHotlistWatchlist(), /watchlist 格式损坏/);
    assert.equal(await resolveDouyinHotlistAccount("douyin-hotlist:missing"), null);
  } finally {
    if (previousRoot === undefined) delete process.env.STYLE_LIBRARY_DIR;
    else process.env.STYLE_LIBRARY_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
