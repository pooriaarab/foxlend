// A stand-in for the parts of the Firefox `browser` object that foxlend
// calls. It copies the Firefox 157 behavior that the failure modes name:
// - a webRequest filter with cookieStoreId is refused (E15).
// The E2E test checks the same flow in a real Firefox.
import type { BrowserLike, ProxyInfo, RequestDetails } from "../src/browser.js";
import { psl } from "./psl.js";

type Listener<A extends unknown[] = unknown[], R = unknown> = (...args: A) => R;

export function fakeBrowser(options: { stores?: Record<string, unknown> } = {}) {
  const data: Record<string, unknown> = structuredClone(options.stores ?? {});
  const on = { request: [] as Listener<[RequestDetails]>[], proxy: [] as Listener<[RequestDetails]>[] };
  const hooks: { storageGet?: () => void; storageSet?: () => void } = {};

  // Only the parts that the guard calls. Later tests add the rest.
  const browser = {
    storage: {
      local: {
        async get(key: string) {
          hooks.storageGet?.();
          return key in data ? { [key]: structuredClone(data[key]) } : {};
        },
        async set(items: Record<string, unknown>) {
          hooks.storageSet?.();
          Object.assign(data, structuredClone(items));
        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener(fn: Listener<[RequestDetails]>, filter: unknown, extra: unknown) {
          if ((filter as Record<string, unknown>).cookieStoreId !== undefined) throw new Error('Type error for parameter filter (Unexpected property "cookieStoreId")');
          if (!(extra as string[]).includes("blocking")) throw new Error("test: the listener must be blocking");
          on.request.push(fn);
        },
      },
    },
    proxy: { onRequest: { addListener: (fn: Listener<[RequestDetails]>) => void on.proxy.push(fn) } },
    publicSuffix: psl,
  } as BrowserLike;

  return {
    browser,
    data,
    hooks,
    /** Send one request through every webRequest listener. */
    request: async (d: RequestDetails) => {
      const answers = await Promise.all(on.request.map((fn) => fn(d)));
      return answers.some((a) => (a as { cancel?: boolean } | undefined)?.cancel === true);
    },
    proxy: async (d: RequestDetails) => (await Promise.all(on.proxy.map((fn) => fn(d))))[0] as ProxyInfo | undefined,
  };
}
