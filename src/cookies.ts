// Which cookies a loan gets, and how (docs/failure-modes.md K1-K9, K11).
// planCopy only reads the cookies of the default container. It returns the
// cookies.set() calls for the loan container and never touches the source.
import { matchesPattern, parsePattern, type PublicSuffix } from "foxgate";
import { hostOf, siteOf, within } from "./site.js";

/** A cookie as Firefox `cookies.getAll` returns it. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "no_restriction" | "lax" | "strict" | "unspecified";
  session: boolean;
  expirationDate?: number;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean } | null;
  storeId: string;
}

/** The details for one Firefox `cookies.set` call. */
export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: Cookie["sameSite"];
  expirationDate: number;
  storeId: string;
  firstPartyDomain?: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
}

export interface SkippedCookie {
  name: string;
  domain: string;
  /** "other-partition": from another top-level site. "not-allowed": a third party not on the allow list. "set-failed": Firefox refused the copy. */
  reason: "expired" | "other-partition" | "not-allowed" | "set-failed";
  message?: string;
}

export interface CopyOptions {
  host: string;
  match: "site" | "host";
  /** From loanPatterns(). */
  patterns: string[];
  /** The loan container. */
  storeId: string;
  /** The loan end, in ms since 1970. */
  endsAt: number;
  now: number;
  publicSuffix: PublicSuffix;
}

const partitionSite = (topLevelSite: string, publicSuffix: PublicSuffix) => {
  try {
    return siteOf(new URL(topLevelSite).hostname, publicSuffix);
  } catch {
    return undefined;
  }
};

/** The cookies.set() calls that copy one site's cookies into the loan container. */
export function planCopy(cookies: Cookie[], options: CopyOptions): { set: CookieSetDetails[]; skipped: SkippedCookie[] } {
  const host = hostOf(options.host);
  const site = siteOf(host, options.publicSuffix);
  const allowed = options.patterns.map((p) => parsePattern(p, options.publicSuffix));
  const set: CookieSetDetails[] = [];
  const skipped: SkippedCookie[] = [];
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    const skip = (reason: SkippedCookie["reason"]) => skipped.push({ name: cookie.name, domain: cookie.domain, reason });
    const topLevelSite = cookie.partitionKey?.topLevelSite;
    if (topLevelSite) {
      if (partitionSite(topLevelSite, options.publicSuffix) !== site) {
        if (within(domain, site)) skip("other-partition");
        continue;
      }
      if (!within(domain, site) && !allowed.some((p) => matchesPattern(domain, p))) {
        skip("not-allowed");
        continue;
      }
    } else {
      if (!within(domain, site)) continue;
      // match "host": only what the browser sends to this host.
      if (options.match === "host" && !(cookie.hostOnly ? domain === host : within(host, domain))) continue;
    }
    const expires = cookie.session || cookie.expirationDate === undefined ? Infinity : cookie.expirationDate;
    if (expires * 1000 <= options.now) {
      skip("expired");
      continue;
    }
    set.push({
      url: `${cookie.secure ? "https" : "http"}://${domain}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Math.min(expires, options.endsAt / 1000),
      storeId: options.storeId,
      ...(cookie.firstPartyDomain === undefined ? {} : { firstPartyDomain: cookie.firstPartyDomain }),
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    });
  }
  return { set, skipped };
}
