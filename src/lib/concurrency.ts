/**
 * 按输入顺序返回结果，并限制同时执行的任务数。
 * 与 Promise.all 一样，单项失败会立即向调用方传播；其他 worker 仍继续运行。
 * 取消由调用方的任务回调处理，此工具不替代资源锁或任务中心。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await run(items[currentIndex], currentIndex);
      }
    })
  );
  return results;
}
