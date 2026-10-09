// The two guard layers (docs/failure-modes.md E1-E15). Both judge each
// request from a loan container with judge().
// 1. A blocking webRequest.onBeforeRequest listener cancels the request.
// 2. A proxy.onRequest listener sends it to a SOCKS proxy that does not
//    exist, with proxyDNS. This also stops speculative connections
//    (<link rel="preconnect">), which webRequest never sees.
import type { PublicSuffix } from "foxgate";
import type { BrowserLike, ProxyInfo, RequestDetails } from "./browser.js";
import { judge, type BlockReason, type Verdict } from "./egress.js";
import type { LoanStore } from "./state.js";

/** A request that the guard stopped. */
export interface BlockedRequest {
  loanId: string;
  url: string;
  host?: string;
  /** The webRequest resource type, or "speculative" for a preconnect. */
  type: string;
  /** The page or script that sent the request, when Firefox knows it. */
  initiator?: string;
  layer: "webRequest" | "proxy";
  reason: BlockReason;
  at: number;
}

/** Port 9 is the discard port. Nothing answers, so the request fails. */
export const DEAD_PROXY: ProxyInfo = { type: "socks", host: "127.0.0.1", port: 9, proxyDNS: true };
const OWN_STORES = new Set(["firefox-default", "firefox-private"]);

export interface GuardOptions {
  browser: BrowserLike;
  store: LoanStore;
  now: () => number;
  publicSuffix: PublicSuffix;
  proxyLayer: boolean;
  onBlocked: (event: BlockedRequest) => void;
}

export function attachGuard({ browser, store, now, publicSuffix, proxyLayer, onBlocked }: GuardOptions): void {
  const decide = (details: RequestDetails, loans: Parameters<typeof judge>[1], layer: BlockedRequest["layer"]) => {
    // Firefox lets a request pass when a blocking listener throws, so an error blocks (E16).
    let verdict: Verdict;
    try {
      // A removed loan container is blocked as if it were still being revoked (L17).
      const all = loans && [...loans, ...store.retired().map((id) => ({ id: "retired", cookieStoreId: id, patterns: [], expiresAt: 0, state: "revoking" as const }))];
      verdict = judge(details, all, now(), publicSuffix);
    } catch {
      verdict = { block: true, loanId: "unknown", reason: "error" };
    }
    if (!verdict.block) return false;
    // webRequest reports what it blocks. The proxy layer reports only what webRequest cannot see.
    if (layer === "webRequest" || details.type === "speculative") {
      const initiator = details.originUrl ?? details.documentUrl;
      onBlocked({ loanId: verdict.loanId, url: details.url, ...(verdict.host ? { host: verdict.host } : {}), type: details.type, ...(initiator ? { initiator } : {}), layer, reason: verdict.reason, at: now() });
    }
    return true;
  };
  // Answer at once when the loans are in memory. Else wait for storage (E12).
  function answer<T>(details: RequestDetails, layer: BlockedRequest["layer"], blocked: T): T | undefined | Promise<T | undefined> {
    const id = details.cookieStoreId;
    if (id === undefined || OWN_STORES.has(id)) return undefined;
    const cached = store.cached();
    if (cached) return decide(details, cached, layer) ? blocked : undefined;
    return store.load().then((loans) => (decide(details, loans, layer) ? blocked : undefined));
  }
  // Firefox refuses a cookieStoreId filter (E15), so listen to all URLs.
  browser.webRequest.onBeforeRequest.addListener((details) => answer(details, "webRequest", { cancel: true }), { urls: ["<all_urls>"] }, ["blocking"]);
  if (proxyLayer && browser.proxy) browser.proxy.onRequest.addListener((details) => answer(details, "proxy", DEAD_PROXY), { urls: ["<all_urls>"] });
}
