export async function withMutationLock<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  run: () => Promise<T>
) {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  queues.set(key, next);

  try {
    // 前一任务的错误已由其调用方处理；这里只等待释放锁，不继承业务失败。
    await previous.catch(() => undefined);
    return await run();
  } finally {
    release();
    if (queues.get(key) === next) queues.delete(key);
  }
}

