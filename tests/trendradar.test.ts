import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getTrendRadarFeed, selectTrendRadarSources } from "../src/lib/trendradar";

test("TrendRadar 按窗口跨日只读，最新记录去重，保留 RSS 与热榜", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trendradar-test-"));
  try {
    assert.equal((await getTrendRadarFeed(undefined, root)).available, false);
    await mkdir(path.join(root, "news"));
    await mkdir(path.join(root, "rss"));
    const news = path.join(root, "news", "2026-01-01.db");
    execFileSync("sqlite3", [news, `
      CREATE TABLE platforms(id TEXT,name TEXT);
      CREATE TABLE crawl_records(id INTEGER,crawl_time TEXT,created_at TEXT);
      CREATE TABLE news_items(id INTEGER,title TEXT,url TEXT,platform_id TEXT,rank INTEGER,first_crawl_time TEXT,last_crawl_time TEXT);
      INSERT INTO platforms VALUES('bili','B站');
      INSERT INTO crawl_records VALUES(1,'09-00','2026-01-01 09:00:00'),(2,'10-00','2026-01-01 10:00:00');
      INSERT INTO news_items VALUES(1,'旧条目已离榜','https://example.com/old','bili',1,'09-00','09-00'),(2,'新增新闻','https://example.com/new','bili',2,'10-00','10-00'),(3,'不安全链接','javascript:alert(1)','bili',3,'10-00','10-00');
    `]);
    execFileSync("sqlite3", [path.join(root, "rss", "2025-12-31.db"), `
      CREATE TABLE rss_feeds(id TEXT,name TEXT);
      CREATE TABLE rss_crawl_records(id INTEGER,crawl_time TEXT,created_at TEXT);
      CREATE TABLE rss_items(id INTEGER,title TEXT,url TEXT,feed_id TEXT,guid TEXT,published_at TEXT,summary TEXT,first_crawl_time TEXT,last_crawl_time TEXT);
      INSERT INTO rss_feeds VALUES('game','游戏媒体');
      INSERT INTO rss_crawl_records VALUES(1,'08:00','2025-12-31 08:00:00');
      INSERT INTO rss_items VALUES(1,'RSS新闻','https://example.com/rss','game','guid1','2025-12-30T23:00:00','摘要','08:00','08:00');
    `]);
    const options = { now: Date.parse("2026-01-01T12:00:00+08:00"), maxAgeHours: 72 };
    const feed = await getTrendRadarFeed(undefined, root, options);
    assert.deepEqual(feed.counts, { hotlist: 2, rss: 1, newItems: 2 });
    assert.equal(feed.items[0].kind, "hotlist");
    assert.equal(feed.items[1].kind, "rss");
    assert.equal(feed.items.find(item => item.title.startsWith("旧"))?.isNew, false);
    assert.equal(feed.items[0].publishedAt, undefined);
    assert.equal(feed.items[1].publishedAt, "2025-12-30T23:00:00.000Z");
    assert.ok(feed.warnings.some(warning => warning.includes("1 条不安全")));
    const selected = selectTrendRadarSources(feed, [feed.items[0].id, feed.items[1].id]);
    assert.equal(selected.length, 2);
    assert.equal(selected[0].items[0].publishedAt, "");
    assert.throws(() => selectTrendRadarSources(feed, ["missing"]), /刷新候选/);
    assert.throws(() => selectTrendRadarSources(feed, []), /1～24/);
    execFileSync("sqlite3", [path.join(root, "news", "2025-12-31.db"), `
      CREATE TABLE platforms(id TEXT,name TEXT);
      CREATE TABLE crawl_records(id INTEGER,crawl_time TEXT,created_at TEXT);
      CREATE TABLE news_items(id INTEGER,title TEXT,url TEXT,platform_id TEXT,rank INTEGER,first_crawl_time TEXT,last_crawl_time TEXT);
      INSERT INTO platforms VALUES('bili','B站');
      INSERT INTO crawl_records VALUES(1,'10-00','2025-12-31 10:00:00');
      INSERT INTO news_items VALUES(1,'昨天独有','https://example.com/yesterday','bili',4,'10-00','10-00'),(2,'昨天旧标题','https://example.com/new','bili',9,'10-00','10-00');
    `]);
    const history = await getTrendRadarFeed(undefined, root, options);
    assert.equal(history.counts.hotlist, 3);
    assert.equal(history.items.find(item => item.url.endsWith('/new'))?.title, '新增新闻');
    assert.equal(history.items.find(item => item.url.endsWith('/yesterday'))?.isNew, false);
    const short = await getTrendRadarFeed(undefined, root, { ...options, maxAgeHours: 6 });
    assert.equal(short.items.some(item => item.url.endsWith('/yesterday')), false);
    // 损坏库诊断可见，健康库和启用的类型仍可读。
    await writeFile(path.join(root, "news", "2026-01-02.db"), "corrupt");
    const partial = await getTrendRadarFeed(undefined, root, { ...options, now: Date.parse("2026-01-02T12:00:00+08:00") });
    assert.equal(partial.available, true);
    assert.ok(partial.items.some(item => item.kind === "rss"));
    assert.ok(partial.warnings.some(item => item.includes("数据库失败")));
    const rssOnly = await getTrendRadarFeed(undefined, root, { ...options, kinds: ["rss"] });
    assert.equal(rssOnly.items.length, 1);
    assert.deepEqual(rssOnly.missing, []);
    assert.deepEqual(rssOnly.warnings, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
