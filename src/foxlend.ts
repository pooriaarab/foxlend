// createFoxlend() wires the guard and lend to the loan records.
import type { Host, PublicSuffix } from "foxgate";
import { emitter, type BrowserLike, type Listenable } from "./browser.js";
import { attachGuard, type BlockedRequest } from "./guard.js";
import { lendLoan, type LendOptions, type LoanContext } from "./lend.js";
import { withDefaultRule } from "./site.js";
import { loanStore, type Loan } from "./state.js";

export interface FoxlendOptions {
  /** The WebExtension `browser` object. */
  browser: BrowserLike;
  /** The foxgate host. foxlend adds one grant per loan. */
  host: Pick<Host, "addGrant" | "revokeGrant">;
  /** Default: withDefaultRule(browser.publicSuffix). Give foxgate the same object. */
  publicSuffix?: PublicSuffix;
  /** The clock, in ms since 1970. Default: Date.now. */
  now?: () => number;
  /** The longest loan, in ms. Default: 24 hours. */
  maxTtlMs?: number;
  /** Also block through proxy.onRequest. Default: true when `browser.proxy` exists. */
  proxyLayer?: boolean;
  /** The browser.storage.local key. Default: "foxlend". */
  storageKey?: string;
}

export interface Foxlend {
  lend(options: LendOptions): Promise<Loan>;
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
  const ctx: LoanContext = {
    browser,
    host: options.host,
    store,
    now: options.now ?? Date.now,
    publicSuffix,
    maxTtlMs: options.maxTtlMs ?? 24 * 60 * 60 * 1000,
  };
  attachGuard({ browser, store, now: ctx.now, publicSuffix, proxyLayer: options.proxyLayer ?? browser.proxy !== undefined, onBlocked: blocked.emit });
  return Object.freeze({
    lend: (lendOptions: LendOptions) => lendLoan(ctx, lendOptions),
    listLoans: async () => structuredClone(await store.loans()),
    onBlocked: blocked.event,
  });
}
