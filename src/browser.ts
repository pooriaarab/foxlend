// The parts of the Firefox WebExtension `browser` object that foxlend calls.
// Pass the real `browser` object. The tests pass a stand-in.
import type { Cookie, CookieSetDetails } from "./cookies.js";
import type { PublicSuffixApi } from "./site.js";

export interface BrowserEvent<F> {
  addListener(fn: F, ...rest: unknown[]): void;
}

/** The fields of webRequest and proxy request details that foxlend reads. */
export interface RequestDetails {
  url: string;
  type: string;
  cookieStoreId?: string;
  originUrl?: string;
  documentUrl?: string;
  tabId?: number;
}

export interface ContextualIdentity {
  name: string;
  color: string;
  icon: string;
  cookieStoreId: string;
}

export interface ProxyInfo {
  type: string;
  host: string;
  port: number;
  proxyDNS?: boolean;
}

type Maybe<T> = T | undefined | Promise<T | undefined>;

export interface BrowserLike {
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  contextualIdentities: {
    create(details: { name: string; color: string; icon: string }): Promise<ContextualIdentity>;
    remove(cookieStoreId: string): Promise<unknown>;
    query(details: { name?: string }): Promise<ContextualIdentity[]>;
    get(cookieStoreId: string): Promise<ContextualIdentity>;
  };
  cookies: {
    getAll(details: Record<string, unknown>): Promise<Cookie[]>;
    set(details: CookieSetDetails): Promise<unknown>;
    remove(details: Record<string, unknown>): Promise<unknown>;
  };
  tabs: {
    create(details: { url: string; cookieStoreId: string; active: boolean }): Promise<{ id?: number }>;
    query(details: { cookieStoreId: string }): Promise<{ id?: number }[]>;
    remove(tabIds: number[]): Promise<void>;
    hide(tabIds: number[]): Promise<unknown>;
  };
  browsingData: { remove(options: { cookieStoreId: string }, types: Record<string, boolean>): Promise<void> };
  alarms: {
    create(name: string, info: { when: number }): unknown;
    clear(name: string): Promise<boolean>;
    onAlarm: BrowserEvent<(alarm: { name: string }) => void>;
  };
  webRequest: { onBeforeRequest: BrowserEvent<(details: RequestDetails) => Maybe<{ cancel: boolean }>> };
  proxy?: { onRequest: BrowserEvent<(details: RequestDetails) => Maybe<ProxyInfo>> };
  privacy?: { network: { networkPredictionEnabled: { set(details: { value: boolean }): Promise<boolean>; clear(details: object): Promise<boolean> } } };
  runtime: { onStartup: BrowserEvent<() => void> };
  publicSuffix?: PublicSuffixApi;
}

/** An event that foxlend fires. */
export interface Listenable<T> {
  addListener(fn: (event: T) => void): void;
  removeListener(fn: (event: T) => void): void;
}

/** A listener that throws does not stop the other listeners. */
export function emitter<T>(): { event: Listenable<T>; emit(value: T): void } {
  const fns = new Set<(event: T) => void>();
  return {
    event: { addListener: (fn) => void fns.add(fn), removeListener: (fn) => void fns.delete(fn) },
    emit(value) {
      for (const fn of fns) {
        try {
          fn(value);
        } catch {
          // One broken listener must not hide the event from the others.
        }
      }
    },
  };
}
