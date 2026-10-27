export type StreamEvent =
  | { type: "stage"; stage: string; message: string; progress?: number; jobId?: string }
  | { type: "delta"; delta: string }
  | { type: "result"; data: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

function encodeEvent(event: StreamEvent) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export function createNdjsonStream(
  handler: (emit: (event: StreamEvent) => void, signal: AbortSignal) => Promise<void>,
  options: { signal?: AbortSignal } = {}
) {
  const abortController = new AbortController();
  const abortFromRequest = () => abortController.abort();

  if (options.signal?.aborted) {
    abortController.abort();
  } else {
    options.signal?.addEventListener("abort", abortFromRequest, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: StreamEvent) => {
        if (abortController.signal.aborted) return;
        controller.enqueue(encodeEvent(event));
      };

      try {
        await handler(emit, abortController.signal);
        if (!abortController.signal.aborted) {
          emit({ type: "done" });
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          emit({
            type: "error",
            message: error instanceof Error ? error.message : "请求处理失败"
          });
        }
      } finally {
        options.signal?.removeEventListener("abort", abortFromRequest);
        try {
          controller.close();
        } catch {
          // The consumer may have already cancelled the stream.
        }
      }
    },
    cancel() {
      abortController.abort();
      options.signal?.removeEventListener("abort", abortFromRequest);
    }
  });
}
