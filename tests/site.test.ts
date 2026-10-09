// Failure modes S1-S5 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { FoxlendError, loanPatterns, siteOf, withDefaultRule } from "../src/index.js";
import { psl } from "./psl.js";

const ps = withDefaultRule(psl);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FoxlendError ? error.code : `not a FoxlendError: ${String(error)}`;
  }
  return "no error";
};

describe("sites", () => {
  it("S1: applies the default rule when no known suffix matches", () => {
    expect(ps.getDomain("www.bank.test")).toBe("bank.test");
    expect(ps.getDomain("a.b.bank.localhost")).toBe("bank.localhost");
    expect(siteOf("www.bank.test", ps)).toBe("bank.test");
  });

  it("S1: keeps the answer of the list when there is one", () => {
    expect(siteOf("a.b.example.co.uk", ps)).toBe("example.co.uk");
    expect(siteOf("alice.github.io", ps)).toBe("alice.github.io");
  });

  it("S2: refuses a public suffix", () => {
    expect(ps.getDomain("github.io")).toBeNull();
    expect(code(() => siteOf("github.io", ps))).toBe("bad-domain");
    expect(code(() => siteOf("co.uk", ps))).toBe("bad-domain");
    expect(code(() => siteOf("test", ps))).toBe("bad-domain");
  });

  it("S3: an IP address is its own site with no subdomain pattern", () => {
    expect(siteOf("10.0.0.7", ps)).toBe("10.0.0.7");
    expect(loanPatterns({ host: "10.0.0.7", match: "site", allow: [], publicSuffix: ps })).toEqual(["10.0.0.7"]);
  });

  it("S4: refuses a scheme, a port, a path, or spaces", () => {
    for (const bad of ["https://bank.test", "bank.test:8080", "bank.test/login", "bank .test", ""]) {
      expect(code(() => siteOf(bad, ps)), bad).toBe("bad-domain");
    }
  });

  it("S5: normalizes case, a trailing dot, and Unicode", () => {
    expect(siteOf("WWW.Bank.Test.", ps)).toBe("bank.test");
    expect(siteOf("www.bücher.test", ps)).toBe("xn--bcher-kva.test");
  });

  it("makes the site patterns, then the allow list", () => {
    expect(loanPatterns({ host: "www.bank.test", match: "site", allow: ["cdn.example.com", "*.pay.test"], publicSuffix: ps })).toEqual([
      "bank.test",
      "*.bank.test",
      "cdn.example.com",
      "*.pay.test",
    ]);
    expect(loanPatterns({ host: "www.bank.test", match: "host", allow: [], publicSuffix: ps })).toEqual(["www.bank.test"]);
  });

  it("refuses an allow entry on a public suffix", () => {
    expect(code(() => loanPatterns({ host: "www.bank.test", match: "site", allow: ["*.github.io"], publicSuffix: ps }))).toBe("bad-allow");
    expect(code(() => loanPatterns({ host: "www.bank.test", match: "site", allow: ["https://x.test/"], publicSuffix: ps }))).toBe("bad-allow");
  });
});
