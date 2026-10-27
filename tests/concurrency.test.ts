import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../src/lib/concurrency";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("并发映射限制在途数量，乱序完成仍按输入顺序返回", async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const starts = Array.from({ length: 4 }, deferred);
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const pending = mapWithConcurrency(["a", "b", "c", "d"], 2, async (item, index) => {
    started.push(index);
    active += 1;
    peak = Math.max(peak, active);
    starts[index].resolve();
    await gates[index].promise;
    active -= 1;
    return `${index}:${item}`;
  });

  assert.deepEqual(started, [0, 1]);
  gates[1].resolve();
  await starts[2].promise;
  gates[2].resolve();
  await starts[3].promise;
  gates[3].resolve();
  gates[0].resolve();
  assert.deepEqual(await pending, ["0:a", "1:b", "2:c", "3:d"]);
  assert.equal(peak, 2);
});

test("空输入不调用任务，并发数大于任务数不会重复执行", async () => {
  assert.deepEqual(await mapWithConcurrency([], 6, async () => assert.fail("不应执行")), []);
  const visited: number[] = [];
  assert.deepEqual(await mapWithConcurrency([1, 2], 6, async (value) => {
    visited.push(value);
    return value;
  }), [1, 2]);
  assert.deepEqual(visited, [1, 2]);
});

test("失败立即传播原错误，其他 worker 保留原有继续执行行为", async () => {
  const gate = deferred();
  const continued = deferred();
  const failure = new Error("采集失败");
  const visited: number[] = [];
  const pending = mapWithConcurrency([0, 1, 2], 2, async (value) => {
    visited.push(value);
    if (value === 0) throw failure;
    if (value === 1) await gate.promise;
    if (value === 2) continued.resolve();
    return value;
  });

  await assert.rejects(pending, (error) => error === failure);
  assert.deepEqual(visited, [0, 1]);
  gate.resolve();
  await continued.promise;
  assert.deepEqual(visited, [0, 1, 2]);
});

test("任务抛出的取消错误保持身份，不被改写或吞掉", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(mapWithConcurrency([1], 1, async () => {
    controller.signal.throwIfAborted();
  }), (error) => error === controller.signal.reason);
});
