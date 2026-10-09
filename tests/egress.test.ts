// Failure modes E1, E2, E7-E11, and E13 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { judge, type LoanState, withDefaultRule } from "../src/index.js";
import { psl } from "./psl.js";

const ps = withDefaultRule(psl);
const NOW = 1_800_000_000_000;
const loan: LoanState = { id: "L1", cookieStoreId: "firefox-container-9", patterns: ["bank.test", "*.bank.test", "cdn.example.com"], expiresAt: NOW + 60_000, state: "active" };
const ask = (url: string, over: Partial<LoanState> = {}, store = "firefox-container-9") =>
  judge({ url, type: "xmlhttprequest", cookieStoreId: store }, [{ ...loan, ...over }], NOW, ps);
const reason = (verdict: ReturnType<typeof ask>) => (verdict.block ? verdict.reason : "pass");

describe("egress allow list", () => {
  it("E1: blocks a host that is not on the list, and names the loan", () => {
    expect(ask("http://attacker.test/steal?d=1")).toEqual({ block: true, loanId: "L1", reason: "not-allowed", host: "attacker.test" });
    expect(reason(ask("https://www.bank.test/account"))).toBe("pass");
    expect(reason(ask("https://bank.test:8443/"))).toBe("pass");
    expect(reason(ask("wss://cdn.example.com/live"))).toBe("pass");
  });

  it("E2: matches by whole labels after normalizing", () => {
    expect(reason(ask("http://bank.test.evil.example/"))).toBe("not-allowed");
    expect(reason(ask("http://evilbank.test/"))).toBe("not-allowed");
    expect(reason(ask("http://x.cdn.example.com/"))).toBe("not-allowed");
    expect(reason(ask("http://WWW.BANK.TEST./"))).toBe("pass");
    expect(reason(ask("http://www.bücher.test/"))).toBe("not-allowed");
    expect(reason(ask("http://www.xn--bcher-kva.test/", { patterns: ["*.bücher.test"] }))).toBe("pass");
  });

  it("E7: blocks an IP address or localhost unless it is on the list exactly", () => {
    expect(reason(ask("http://127.0.0.1/"))).toBe("not-allowed");
    expect(reason(ask("http://localhost/"))).toBe("not-allowed");
    expect(reason(ask("http://10.0.0.7/", { patterns: ["10.0.0.7"] }))).toBe("pass");
  });

  it("E8: blocks other schemes, and lets local schemes pass", () => {
    expect(reason(ask("ftp://bank.test/file"))).toBe("bad-url");
    expect(reason(ask("file:///etc/passwd"))).toBe("bad-url");
    for (const url of ["data:text/plain,hi", "blob:http://bank.test/1f1f", "about:blank"]) expect(reason(ask(url)), url).toBe("pass");
  });

  it("E9: blocks a URL that does not parse, and an IPv6 host", () => {
    expect(reason(ask("not a url"))).toBe("bad-url");
    expect(reason(ask("http://[::1]/"))).toBe("bad-url");
  });

  it("E10: blocks everything after the loan end, also an allowed host", () => {
    expect(reason(ask("https://www.bank.test/", { expiresAt: NOW }))).toBe("expired");
  });

  it("E11: blocks everything while the loan is being revoked", () => {
    expect(reason(ask("https://www.bank.test/", { state: "revoking" }))).toBe("revoking");
  });

  it("judges a loan that is still being created by its patterns", () => {
    expect(reason(ask("https://www.bank.test/", { state: "creating" }))).toBe("pass");
    expect(reason(ask("http://attacker.test/", { state: "creating" }))).toBe("not-allowed");
  });

  it("E13: with no loan list, blocks every container but the default and the private one", () => {
    const blind = (store: string | undefined) => judge({ url: "https://www.bank.test/", type: "image", cookieStoreId: store }, undefined, NOW, ps);
    expect(blind("firefox-container-3")).toEqual({ block: true, loanId: "unknown", reason: "no-state", host: "www.bank.test" });
    expect(blind("firefox-default").block).toBe(false);
    expect(blind("firefox-private").block).toBe(false);
    expect(blind(undefined).block).toBe(false);
  });

  it("lets requests from other containers pass", () => {
    expect(reason(ask("http://attacker.test/", {}, "firefox-default"))).toBe("pass");
    expect(reason(ask("http://attacker.test/", {}, "firefox-container-2"))).toBe("pass");
  });
});
