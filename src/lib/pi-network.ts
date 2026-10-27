import { AsyncLocalStorage } from "node:async_hooks";
import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { chatDispatcher } from "./model-runtime";

const state = globalThis as typeof globalThis & { piNetworkContext?: AsyncLocalStorage<Dispatcher> };

export function withPiNetwork<T>(run: () => T): T {
  if (!state.piNetworkContext) {
    const context = state.piNetworkContext = new AsyncLocalStorage<Dispatcher>();
    const fallback = getGlobalDispatcher();
    // Pi OAuth uses global fetch; scope its dispatcher to this async operation.
    setGlobalDispatcher(new class extends Dispatcher {
      dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
        return (context.getStore() || fallback).dispatch(options, handler);
      }
    }());
  }
  const proxy = chatDispatcher(process.env.CHAT_PROXY_URL || "");
  return proxy ? state.piNetworkContext.run(proxy, run) : run();
}
