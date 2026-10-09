// The egress allow list (docs/failure-modes.md E1-E15). judge() decides one
// request. The webRequest and proxy listeners in loans.ts call it.
import { matchesPattern, parsePattern, type DomainPattern, type PublicSuffix } from "foxgate";
import { hostOf } from "./site.js";

/** What the guard needs to know about a loan. */
export interface LoanState {
  id: string;
  /** Not set until the container exists. */
  cookieStoreId?: string;
  /** From loanPatterns(). */
  patterns: string[];
  expiresAt: number;
  state: "creating" | "active" | "revoking";
}

/** The fields of a webRequest or proxy request details object that judge() reads. */
export interface RequestInfo {
  url: string;
  type: string;
  cookieStoreId?: string;
}

export type BlockReason = "not-allowed" | "expired" | "revoking" | "bad-url" | "no-state" | "error";
export type Verdict = { block: false } | { block: true; loanId: string; reason: BlockReason; host?: string };

const PASS: Verdict = { block: false };
const NETWORK = new Set(["http:", "https:", "ws:", "wss:"]);
const LOCAL = new Set(["data:", "blob:", "about:"]);
const OWN_STORES = new Set(["firefox-default", "firefox-private"]);
const compiled = new Map<string, DomainPattern>();

// A pattern that no longer parses (the public suffix list changed) matches nothing (E16).
const matches = (host: string, pattern: string, publicSuffix: PublicSuffix) => {
  let parsed = compiled.get(pattern);
  if (!parsed) {
    try {
      parsed = parsePattern(pattern, publicSuffix);
    } catch {
      return false;
    }
    compiled.set(pattern, parsed);
  }
  return matchesPattern(host, parsed);
};

/** The host of a network URL, "local" for a URL that stays in the browser, or undefined for anything else. */
function hostOfUrl(url: string): string | "local" | undefined {
  try {
    const parsed = new URL(url);
    if (LOCAL.has(parsed.protocol)) return "local";
    if (!NETWORK.has(parsed.protocol)) return undefined;
    return hostOf(parsed.hostname);
  } catch {
    return undefined;
  }
}

/**
 * Decide one request. `loans` undefined means the loan list could not be
 * read: then every container other than the default and the private one is
 * blocked (E13).
 */
export function judge(request: RequestInfo, loans: LoanState[] | undefined, now: number, publicSuffix: PublicSuffix): Verdict {
  const store = request.cookieStoreId;
  if (!loans) {
    if (store === undefined || OWN_STORES.has(store)) return PASS;
    const host = hostOfUrl(request.url);
    return { block: true, loanId: "unknown", reason: "no-state", ...(host && host !== "local" ? { host } : {}) };
  }
  const loan = store === undefined ? undefined : loans.find((l) => l.cookieStoreId === store);
  if (!loan) return PASS;
  const host = hostOfUrl(request.url);
  const block = (reason: BlockReason): Verdict => ({ block: true, loanId: loan.id, reason, ...(host && host !== "local" ? { host } : {}) });
  if (loan.state === "revoking") return block("revoking");
  if (now >= loan.expiresAt) return block("expired");
  if (host === "local") return PASS;
  if (host === undefined) return block("bad-url");
  return loan.patterns.some((p) => matches(host, p, publicSuffix)) ? PASS : block("not-allowed");
}
