// A stand-in for the parts of the Firefox `browser` object that foxlend
// calls. It copies the Firefox 157 behavior that the failure modes name:
// - a webRequest filter with cookieStoreId is refused (E15),
// - browsingData refuses serviceWorkers with cookieStoreId (L6),
// - removing a container leaves its tabs open (L5),
// - SameSite=None without Secure is refused by cookies.set (K12).
// The E2E test checks the same flow in a real Firefox.
import type { BrowserLike, ContextualIdentity, ProxyInfo, RequestDetails } from "../src/browser.js";
import type { Cookie, CookieSetDetails } from "../src/cookies.js";
import { psl } from "./psl.js";

const sameKey = (a: { name: string; domain?: string; path?: string; partitionKey?: unknown }, b: Cookie) =>
  a.name === b.name && a.domain === b.domain && a.path === b.path && JSON.stringify(a.partitionKey ?? null) === JSON.stringify(b.partitionKey ?? null);

type Listener<A extends unknown[] = unknown[], R = unknown> = (...args: A) => R;

export function fakeBrowser(options: { stores?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const data: Record<string, unknown> = structuredClone(options.stores ?? {});
  const cookies = new Map<string, Cookie[]>([["firefox-default", []]]);
  const containers: ContextualIdentity[] = [];
  const tabs: { id: number; cookieStoreId: string; url: string; hidden: boolean; active: boolean }[] = [];
  const alarms = new Map<string, number>();
  let nextContainer = 1;
  let nextTab = 1;
  const on = { request: [] as Listener<[RequestDetails]>[], proxy: [] as Listener<[RequestDetails]>[], alarm: [] as Listener<[{ name: string }]>[], startup: [] as Listener[] };
  const hooks: { storageGet?: () => void; storageSet?: () => void; tabsRemove?: () => void | Promise<void>; containerRemove?: () => void; containerGet?: () => void; tabsHide?: () => void; tabsCreate?: () => void } = {};
  const prediction: { value: boolean | undefined } = { value: undefined };
  const jar = (storeId: string) => {
    if (!cookies.has(storeId)) cookies.set(storeId, []);
    return cookies.get(storeId)!;
  };

  const browser: BrowserLike = {
    storage: {
      local: {
        async get(key) {
          hooks.storageGet?.();
          return key in data ? { [key]: structuredClone(data[key]) } : {};
        },
        async set(items) {
          hooks.storageSet?.();
          Object.assign(data, structuredClone(items));
        },
      },
    },
    contextualIdentities: {
      async create(d) {
        const ci = { ...d, cookieStoreId: `firefox-container-${nextContainer++}` };
        containers.push(ci);
        calls.push(`container.create ${ci.cookieStoreId}`);
        return { ...ci };
      },
      async remove(id) {
        hooks.containerRemove?.();
        const i = containers.findIndex((c) => c.cookieStoreId === id);
        if (i < 0) throw new Error(`Invalid contextual identity: ${id}`);
        containers.splice(i, 1);
        cookies.delete(id);
        calls.push(`container.remove ${id}`);
        return true;
      },
      async query(d) {
        return containers.filter((c) => d.name === undefined || c.name === d.name).map((c) => ({ ...c }));
      },
      async get(id) {
        hooks.containerGet?.();
        const found = containers.find((c) => c.cookieStoreId === id);
        if (!found) throw new Error(`Invalid contextual identity: ${id}`);
        return { ...found };
      },
    },
    cookies: {
      async getAll(d) {
        if (d.storeId === undefined) throw new Error("test: give a storeId");
        if (d.partitionKey === undefined) return jar(String(d.storeId)).filter((c) => !c.partitionKey).map((c) => ({ ...c }));
        return jar(String(d.storeId)).map((c) => ({ ...c }));
      },
      async set(d: CookieSetDetails) {
        if (d.sameSite === "no_restriction" && !d.secure) throw new Error(`Cookie “${d.name}” rejected because it has the “SameSite=None” attribute but is missing the “secure” attribute.`);
        const host = new URL(d.url).hostname;
        const cookie: Cookie = {
          name: d.name,
          value: d.value,
          domain: d.domain ?? host,
          hostOnly: d.domain === undefined,
          path: d.path,
          secure: d.secure,
          httpOnly: d.httpOnly,
          sameSite: d.sameSite,
          session: false,
          expirationDate: d.expirationDate,
          firstPartyDomain: d.firstPartyDomain ?? "",
          partitionKey: d.partitionKey ?? null,
          storeId: d.storeId,
        };
        const list = jar(d.storeId);
        const i = list.findIndex((c) => sameKey(cookie, c));
        if (i >= 0) list.splice(i, 1);
        list.push(cookie);
        calls.push(`cookies.set ${d.storeId} ${d.name}`);
        return { ...cookie };
      },
      async remove(d) {
        const list = jar(String(d.storeId));
        const host = new URL(String(d.url)).hostname;
        const i = list.findIndex((c) => c.name === d.name && c.domain.replace(/^\./, "") === host && JSON.stringify(c.partitionKey ?? null) === JSON.stringify(d.partitionKey ?? null));
        if (i >= 0) list.splice(i, 1);
        calls.push(`cookies.remove ${String(d.storeId)} ${String(d.name)}`);
        return null;
      },
    },
    tabs: {
      async create(d) {
        hooks.tabsCreate?.();
        const tab = { id: nextTab++, cookieStoreId: d.cookieStoreId, url: d.url, hidden: false, active: d.active };
        tabs.push(tab);
        calls.push(`tabs.create ${d.cookieStoreId}`);
        return { id: tab.id };
      },
      async query(d) {
        return tabs.filter((t) => t.cookieStoreId === d.cookieStoreId).map((t) => ({ id: t.id }));
      },
      async remove(ids) {
        await hooks.tabsRemove?.();
        for (const id of ids) tabs.splice(tabs.findIndex((t) => t.id === id), 1);
        calls.push(`tabs.remove ${ids.join(",")}`);
      },
      async hide(ids) {
        hooks.tabsHide?.();
        for (const tab of tabs) if (ids.includes(tab.id)) tab.hidden = true;
        return ids;
      },
    },
    browsingData: {
      async remove(o, types) {
        if (types.serviceWorkers) throw new Error("Firefox does not support clearing serviceWorkers with 'cookieStoreId'.");
        if (types.cookies) jar(o.cookieStoreId).length = 0;
        calls.push(`browsingData.remove ${o.cookieStoreId}`);
      },
    },
    alarms: {
      create: (name, info) => void alarms.set(name, info.when),
      clear: async (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => void on.alarm.push(fn) },
    },
    webRequest: {
      onBeforeRequest: {
        addListener(fn, filter, extra) {
          if ((filter as Record<string, unknown>).cookieStoreId !== undefined) throw new Error('Type error for parameter filter (Unexpected property "cookieStoreId")');
          if (!(extra as string[]).includes("blocking")) throw new Error("test: the listener must be blocking");
          on.request.push(fn);
        },
      },
    },
    proxy: { onRequest: { addListener: (fn) => void on.proxy.push(fn) } },
    privacy: {
      network: {
        networkPredictionEnabled: {
          set: async (d) => ((prediction.value = d.value), true),
          clear: async () => ((prediction.value = undefined), true),
        },
      },
    },
    runtime: { onStartup: { addListener: (fn) => void on.startup.push(fn) } },
    publicSuffix: psl,
  };

  return {
    browser,
    calls,
    data,
    cookies,
    containers,
    tabs,
    alarms,
    hooks,
    prediction,
    /** Send one request through every webRequest listener. */
    request: async (d: RequestDetails) => {
      const answers = await Promise.all(on.request.map((fn) => fn(d)));
      return answers.some((a) => (a as { cancel?: boolean } | undefined)?.cancel === true);
    },
    proxy: async (d: RequestDetails) => (await Promise.all(on.proxy.map((fn) => fn(d))))[0] as ProxyInfo | undefined,
    fireAlarm: async (name: string) => on.alarm.forEach((fn) => fn({ name })),
    startup: async () => on.startup.forEach((fn) => fn()),
  };
}
