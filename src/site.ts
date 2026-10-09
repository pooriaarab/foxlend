// Sites and host patterns (docs/failure-modes.md S1-S5). A loan is for one
// site: the registrable domain (eTLD+1) of the host you lend.
import { normalizeHost, parsePattern, type PublicSuffix } from "foxgate";
import { FoxlendError } from "./errors.js";

/** The parts of Firefox `browser.publicSuffix` (153+) that foxlend reads. */
export interface PublicSuffixApi {
  getDomain(host: string): string | null | undefined;
  getKnownSuffix(host: string): string | null | undefined;
}

export const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Wrap `browser.publicSuffix` with the default rule of the public suffix list
 * ("*"): a host on a top-level domain that is not on the list (for example
 * `.test` or `.localhost`) has the last two labels as its site. Firefox
 * returns null for these hosts. Pass the result to foxgate too.
 */
export function withDefaultRule(api: PublicSuffixApi): PublicSuffix {
  return {
    getDomain(host: string) {
      const domain = api.getDomain(host);
      if (domain) return domain;
      if (api.getKnownSuffix(host) || IPV4.test(host)) return null;
      const labels = host.split(".");
      return labels.length >= 2 ? labels.slice(-2).join(".") : null;
    },
  };
}

/** Lowercase punycode host. Throws FoxlendError `bad-domain`. */
export function hostOf(input: string): string {
  try {
    return normalizeHost(input);
  } catch (error) {
    throw new FoxlendError("bad-domain", `${JSON.stringify(input)} is not a host. Give a host only, for example www.example.com.`, { cause: error });
  }
}

/** The registrable domain of a host. Throws FoxlendError `bad-domain` for a public suffix. */
export function siteOf(input: string, publicSuffix: PublicSuffix): string {
  const host = hostOf(input);
  if (IPV4.test(host)) return host;
  const site = publicSuffix.getDomain(host);
  if (!site) throw new FoxlendError("bad-domain", `${host} is a public suffix, not a site.`);
  return site;
}

/** True when `host` is `domain` or a subdomain of it, by whole labels. */
export const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export interface PatternInput {
  host: string;
  /** "site": the site and all its subdomains. "host": the exact host only. */
  match: "site" | "host";
  allow: string[];
  publicSuffix: PublicSuffix;
}

/**
 * The host patterns of a loan: the lent site (or host), then the allow list.
 * The same strings are the egress allow list and the foxgate grant domains.
 */
export function loanPatterns({ host, match, allow, publicSuffix }: PatternInput): string[] {
  const exact = hostOf(host);
  const site = siteOf(exact, publicSuffix);
  const own = match === "host" ? [exact] : IPV4.test(site) ? [site] : [site, `*.${site}`];
  const extra = allow.map((entry) => {
    try {
      const pattern = parsePattern(entry, publicSuffix);
      return pattern.kind === "exact" ? pattern.host : `*.${pattern.host}`;
    } catch (error) {
      throw new FoxlendError("bad-allow", `${JSON.stringify(entry)} cannot be on the allow list. Give a host or *. plus a host that is not a public suffix.`, { cause: error });
    }
  });
  return [...new Set([...own, ...extra])];
}
