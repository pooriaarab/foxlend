// Failure modes K1-K9 and K11 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { type Cookie, loanPatterns, planCopy, withDefaultRule } from "../src/index.js";
import { psl } from "./psl.js";

const ps = withDefaultRule(psl);
const NOW = 1_800_000_000_000;
const ENDS = NOW + 60 * 60 * 1000;

const cookie = (over: Partial<Cookie>): Cookie => ({
  name: "c",
  value: "v",
  domain: "www.bank.test",
  hostOnly: true,
  path: "/",
  secure: false,
  httpOnly: false,
  sameSite: "lax",
  session: true,
  firstPartyDomain: "",
  partitionKey: null,
  storeId: "firefox-default",
  ...over,
});

const plan = (cookies: Cookie[], host = "www.bank.test", match: "site" | "host" = "site", allow: string[] = []) =>
  planCopy(cookies, { host, match, patterns: loanPatterns({ host, match, allow, publicSuffix: ps }), storeId: "firefox-container-9", endsAt: ENDS, now: NOW, publicSuffix: ps });
const names = (p: ReturnType<typeof plan>) => p.set.map((s) => s.name);

describe("cookie copy", () => {
  it("K1: copies the site and its subdomains, not sibling sites on a shared suffix", () => {
    const p = plan(
      [
        cookie({ name: "mine", domain: "alice.github.io" }),
        cookie({ name: "sub", domain: ".api.alice.github.io", hostOnly: false }),
        cookie({ name: "bob", domain: "bob.github.io" }),
        cookie({ name: "suffix", domain: ".github.io", hostOnly: false }),
      ],
      "alice.github.io",
    );
    expect(names(p)).toEqual(["mine", "sub"]);
  });

  it("K2: does not copy look-alike domains", () => {
    const p = plan([
      cookie({ name: "ok", domain: ".bank.test", hostOnly: false }),
      cookie({ name: "evil1", domain: "evilbank.test" }),
      cookie({ name: "evil2", domain: "bank.test.evil.example" }),
      cookie({ name: "evil3", domain: ".xbank.test", hostOnly: false }),
    ]);
    expect(names(p)).toEqual(["ok"]);
  });

  it("K3: copies a partitioned cookie in the site partition when its host is the site or allowed", () => {
    const key = { topLevelSite: "http://bank.test", hasCrossSiteAncestor: true };
    const p = plan(
      [
        cookie({ name: "widget", domain: "widget.example.com", partitionKey: key }),
        cookie({ name: "tracker", domain: "tracker.example.com", partitionKey: key }),
        cookie({ name: "chips", domain: "www.bank.test", partitionKey: { topLevelSite: "https://www.bank.test" } }),
      ],
      "www.bank.test",
      "site",
      ["widget.example.com"],
    );
    expect(names(p)).toEqual(["widget", "chips"]);
    expect(p.skipped).toEqual([{ name: "tracker", domain: "tracker.example.com", reason: "not-allowed" }]);
  });

  it("K4: does not copy the site cookie from the partition of another site", () => {
    const p = plan([cookie({ name: "embedded", domain: "www.bank.test", partitionKey: { topLevelSite: "https://news.example.com" } })]);
    expect(names(p)).toEqual([]);
    expect(p.skipped).toEqual([{ name: "embedded", domain: "www.bank.test", reason: "other-partition" }]);
  });

  it("K5: keeps the partition key", () => {
    const key = { topLevelSite: "http://bank.test", hasCrossSiteAncestor: true };
    const p = plan([cookie({ name: "w", domain: "widget.example.com", partitionKey: key })], "www.bank.test", "site", ["widget.example.com"]);
    expect(p.set[0]?.partitionKey).toEqual(key);
    expect(plan([cookie({ name: "plain" })]).set[0]).not.toHaveProperty("partitionKey");
  });

  it("K6: keeps HttpOnly, Secure, SameSite, the path, and host-only", () => {
    const p = plan([
      cookie({ name: "session", httpOnly: true, secure: true, sameSite: "strict", path: "/app" }),
      cookie({ name: "pref", domain: ".bank.test", hostOnly: false, sameSite: "no_restriction", secure: true }),
    ]);
    expect(p.set[0]).toMatchObject({ url: "https://www.bank.test/app", name: "session", httpOnly: true, secure: true, sameSite: "strict", path: "/app", storeId: "firefox-container-9" });
    expect(p.set[0]).not.toHaveProperty("domain");
    expect(p.set[1]).toMatchObject({ url: "https://bank.test/", domain: ".bank.test", sameSite: "no_restriction" });
  });

  it("K7: caps the expiry at the loan end, and gives a session cookie the loan end", () => {
    const p = plan([
      cookie({ name: "long", session: false, expirationDate: ENDS / 1000 + 86_400 }),
      cookie({ name: "short", session: false, expirationDate: NOW / 1000 + 60 }),
      cookie({ name: "session", session: true }),
    ]);
    expect(p.set.map((s) => s.expirationDate)).toEqual([ENDS / 1000, NOW / 1000 + 60, ENDS / 1000]);
  });

  it("K8: does not copy an expired cookie", () => {
    const p = plan([cookie({ name: "old", session: false, expirationDate: NOW / 1000 - 1 })]);
    expect(names(p)).toEqual([]);
    expect(p.skipped).toEqual([{ name: "old", domain: "www.bank.test", reason: "expired" }]);
  });

  it("K9: passes firstPartyDomain through", () => {
    const p = plan([cookie({ name: "fpi", firstPartyDomain: "bank.test" })]);
    expect(p.set[0]?.firstPartyDomain).toBe("bank.test");
  });

  it("K11: with match host, copies only the cookies that the host receives", () => {
    const p = plan(
      [
        cookie({ name: "own", domain: "www.bank.test" }),
        cookie({ name: "parent", domain: ".bank.test", hostOnly: false }),
        cookie({ name: "sibling", domain: "mail.bank.test" }),
        cookie({ name: "siblingDomain", domain: ".mail.bank.test", hostOnly: false }),
        cookie({ name: "child", domain: "a.www.bank.test" }),
      ],
      "www.bank.test",
      "host",
    );
    expect(names(p)).toEqual(["own", "parent"]);
  });

  it("never copies into the source store and ignores cookies of unrelated sites without a report", () => {
    const p = plan([cookie({ name: "other", domain: "mail.example.com" }), cookie({ name: "own" })]);
    expect(names(p)).toEqual(["own"]);
    expect(p.skipped).toEqual([]);
    expect(p.set.every((s) => s.storeId === "firefox-container-9")).toBe(true);
  });
});
