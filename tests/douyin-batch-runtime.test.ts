import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildDouyinBatchPostExtractJs } from "../src/lib/opencli-douyin-scripts";

async function run(fetch: (url: string) => Promise<unknown>, count = 1) {
  return vm.runInNewContext(buildDouyinBatchPostExtractJs({
    accounts: Array.from({ length: count }, (_, i) => ({ id: String(i), uid: String(i), name: String(i) })),
    concurrency: 1, limit: 20, fromDate: "2026-09-06", toDate: "2026-09-08"
  }), { document: { cookie: "UIFID=test-token" }, URL, AbortSignal, fetch, setTimeout: (fn: () => void) => fn() });
}

test("共享批量接口保留真实时间和互动字段，旧置顶作品不阻断分页", async () => {
  let calls = 0;
  const created = Math.floor(Date.parse("2026-09-07T10:00:00Z") / 1000);
  const result = await run(async (url) => {
    assert.equal(new URL(url).searchParams.get("uifid"), "test-token");
    calls++;
    return { ok: true, text: async () => JSON.stringify({ status_code: 0, aweme_list: calls === 1
      ? [{ aweme_id: "old", create_time: 1, is_top: 1 }]
      : [{ aweme_id: "new", create_time: created, statistics: { comment_count: 12, collect_count: 8 } }],
    has_more: calls === 1, max_cursor: calls === 1 ? 123 : 0 }) };
  });
  assert.equal(calls, 2);
  assert.equal(result[0].rows[0].create_time, created);
  assert.equal(result[0].rows[0].comment_count, 12);
  assert.equal(result[0].rows[0].collect_count, 8);
});

test("接口缺字段不能伪装成空账号成功", async () => {
  const result = await run(async () => ({ ok: true, text: async () => "{}" }));
  assert.equal(result[0].status, "failed");
  assert.match(result[0].error, /缺少作品列表/);
});

test("日期筛选拒绝缺少真实时间的作品", async () => {
  const result = await run(async () => ({ ok: true, text: async () => JSON.stringify({ aweme_list: [{ aweme_id: "123" }] }) }));
  assert.equal(result[0].status, "failed");
  assert.match(result[0].error, /真实发布时间/);
});

test("访问受限后不再发送排队账号请求", async () => {
  for (const status of [401, 403, 444, 429]) {
    let calls = 0;
    const result = await run(async () => { calls++; return { ok: false, status, text: async () => "Access Denied" }; }, 3);
    assert.equal(calls, 1);
    assert.ok(result.every((item: { status: string }) => item.status === "failed"));
  }
});

test("不限时间按互动排序先翻完历史，不能在最近一页凑够数量就停止", async () => {
  for (const ranking of ["likes", "comments"] as const) {
    let calls = 0;
    const result = await vm.runInNewContext(buildDouyinBatchPostExtractJs({
      accounts: [{ id: "a", uid: "a", name: "a" }], concurrency: 1, limit: 1, ranking
    }), {
      document: { cookie: "UIFID=test" }, URL, AbortSignal, setTimeout: (fn: () => void) => fn(),
      fetch: async () => {
        calls++;
        return { ok: true, text: async () => JSON.stringify({
          aweme_list: [{ aweme_id: calls === 1 ? "recent" : "old", create_time: calls === 1 ? 1788524143 : 1688524143,
            statistics: { digg_count: calls * 100, comment_count: calls * 10 } }],
          has_more: calls === 1, max_cursor: calls === 1 ? 123 : 0
        }) };
      }
    });
    assert.equal(calls, 2);
    assert.equal(result[0].status, "completed");
    assert.equal(result[0].rows.length, 1);
    assert.equal(result[0].rows[0].aweme_id, "old");
    assert.equal(result[0].rawCount, 2);
  }
});

test("历史分页游标异常不能返回局部排序成功", async () => {
  const result = await vm.runInNewContext(buildDouyinBatchPostExtractJs({
    accounts: [{ id: "a", uid: "a", name: "a" }], concurrency: 1, limit: 1, ranking: "likes"
  }), {
    document: { cookie: "UIFID=test" }, URL, AbortSignal, setTimeout: (fn: () => void) => fn(),
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ aweme_list: [{ aweme_id: "recent" }], has_more: 1, max_cursor: 0 }) })
  });
  assert.equal(result[0].status, "failed");
  assert.match(result[0].error, /游标未推进/);
});

test("历史采集达到分页安全上限时明确失败，不冒充全量排序", async () => {
  let calls = 0;
  const result = await vm.runInNewContext(buildDouyinBatchPostExtractJs({
    accounts: [{ id: "a", uid: "a", name: "a" }], concurrency: 1, limit: 1, ranking: "likes"
  }), {
    document: { cookie: "UIFID=test" }, URL, AbortSignal, setTimeout: (fn: () => void) => fn(),
    fetch: async () => {
      calls++;
      return { ok: true, text: async () => JSON.stringify({ aweme_list: [{ aweme_id: String(calls) }], has_more: 1, max_cursor: calls }) };
    }
  });
  assert.equal(calls, 500);
  assert.equal(result[0].status, "failed");
  assert.match(result[0].error, /500 页/);
});

test("按互动排序仍遵守日期边界，旧置顶不会截断范围内的后续页", async () => {
  let calls = 0;
  const epoch = (date: string) => Date.parse(date) / 1000;
  const result = await vm.runInNewContext(buildDouyinBatchPostExtractJs({
    accounts: [{ id: "a", uid: "a", name: "a" }], concurrency: 1, limit: 1,
    ranking: "likes", fromDate: "2025-01-01", toDate: "2025-12-31"
  }), {
    document: { cookie: "UIFID=test" }, URL, AbortSignal, setTimeout: (fn: () => void) => fn(),
    fetch: async () => {
      calls++;
      const items = calls === 1
        ? [{ aweme_id: "pinned", is_top: 1, create_time: epoch("2023-05-01"), statistics: { digg_count: 999 } },
          { aweme_id: "recent", create_time: epoch("2026-05-01"), statistics: { digg_count: 999 } }]
        : [{ aweme_id: "wanted", create_time: epoch("2025-05-01"), statistics: { digg_count: 100 } },
          { aweme_id: "past", create_time: epoch("2024-05-01"), statistics: { digg_count: 999 } }];
      return { ok: true, text: async () => JSON.stringify({ aweme_list: items, has_more: 1, max_cursor: calls }) };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result[0].status, "completed");
  assert.equal(result[0].rows[0].aweme_id, "wanted");
});

test("历史采集短批次返回游标，下一批从游标继续并最终结束", async () => {
  const seenCursors: string[] = [];
  const runPage = (pageCursor: number) => vm.runInNewContext(buildDouyinBatchPostExtractJs({
    accounts: [{ id: "a", uid: "a", name: "a" }], concurrency: 1, limit: 1,
    ranking: "likes", pageBudget: 1, pageCursor
  }), {
    document: { cookie: "UIFID=test" }, URL, AbortSignal, setTimeout: (fn: () => void) => fn(),
    fetch: async (url: string) => {
      const cursor = new URL(url).searchParams.get("max_cursor")!;
      seenCursors.push(cursor);
      return { ok: true, text: async () => JSON.stringify({
        aweme_list: [{ aweme_id: cursor === "0" ? "recent" : "old", statistics: { digg_count: 100 } }],
        has_more: cursor === "0", max_cursor: cursor === "0" ? 123 : 0
      }) };
    }
  });
  const first = (await runPage(0))[0];
  assert.equal(first.status, "completed");
  assert.equal(first.nextCursor, 123);
  const last = (await runPage(first.nextCursor))[0];
  assert.equal(last.nextCursor, null);
  assert.equal(last.rows[0].aweme_id, "old");
  assert.deepEqual(seenCursors, ["0", "123"]);
});
