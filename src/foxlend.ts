// createFoxlend() wires the guard to the loan records.
import type { PublicSuffix } from "foxgate";
import { emitter, type BrowserLike, type Listenable } from "./browser.js";
import { attachGuard, type BlockedRequest } from "./guard.js";
import { withDefaultRule } from "./site.js";
import { loanStore, type Loan } from "./state.js";

export interface FoxlendOptions {
  /** The WebExtension `browser` object. */
  browser: BrowserLike;
  /** Default: withDefaultRule(browser.publicSuffix). Give foxgate the same object. */
  publicSuffix?: PublicSuffix;
  /** The clock, in ms since 1970. Default: Date.now. */
  now?: () => number;
  /** Also block through proxy.onRequest. Default: true when `browser.proxy` exists. */
  proxyLayer?: boolean;
  /** The browser.storage.local key. Default: "foxlend". */
  storageKey?: string;
}

export interface Foxlend {
  listLoans(): Promise<Loan[]>;
  onBlocked: Listenable<BlockedRequest>;
}

/**
 * Call this at the top level of the background script, so Firefox can wake
 * the event page for a request from a loan container.
 */
export function createFoxlend(options: FoxlendOptions): Foxlend {
  const { browser } = options;
  const publicSuffix = options.publicSuffix ?? (browser.publicSuffix ? withDefaultRule(browser.publicSuffix) : undefined);
  if (!publicSuffix) throw new TypeError("foxlend needs a public suffix list: Firefox 153+ with the publicSuffix permission, or the publicSuffix option.");
  const store = loanStore(browser, options.storageKey ?? "foxlend");
  const blocked = emitter<BlockedRequest>();
  const now = options.now ?? Date.now;
  attachGuard({ browser, store, now, publicSuffix, proxyLayer: options.proxyLayer ?? browser.proxy !== undefined, onBlocked: blocked.emit });
  return Object.freeze({
    listLoans: async () => structuredClone(await store.loans()),
    onBlocked: blocked.event,
  });
}
