// Failure modes for the guard wiring and the loan life cycle in
// docs/failure-modes.md. The stand-in browser copies the Firefox behavior
// that each failure mode names. e2e/run.mjs checks the same in Firefox.
import { createFoxgate } from "foxgate";
import { describe, expect, it } from "vitest";
import { createFoxlend, DEAD_PROXY, FoxlendError, withDefaultRule, type BlockedRequest, type Cookie } from "../src/index.js";
import { fakeBrowser } from "./fake-browser.js";
import { psl } from "./psl.js";

const ps = withDefaultRule(psl);
const NOW = 1_800_000_000_000;
const STORE = "firefox-container-9";

function setup(stores?: Record<string, unknown>, fb = fakeBrowser({ stores })) {
  const clock = { now: NOW };
  const { host } = createFoxgate({ tools: { open_page: "read", submit_form: "submit" }, publicSuffix: ps, now: () => clock.now });
  const lender = createFoxlend({ browser: fb.browser, host, now: () => clock.now });
  const blocked: BlockedRequest[] = [];
  lender.onBlocked.addListener((e) => blocked.push(e));
  return { fb, host, lender, blocked, clock };
}

const errorCode = async (promise: Promise<unknown>) =>
  promise.then(
    () => "no error",
    (error: unknown) => (error instanceof FoxlendError ? error.code : `not a FoxlendError: ${String(error)}`),
  );

const seeded = (over: Record<string, unknown> = {}) => ({
  foxlend: { loans: [{ id: "L1", cookieStoreId: STORE, patterns: ["bank.test", "*.bank.test"], expiresAt: NOW + 60_000, state: "active", ...over }] },
});

describe("guard wiring", () => {
  it("E1: cancels a request to a blocked host and reports the URL, type, and initiator", async () => {
    const { fb, blocked } = setup(seeded());
    const url = "http://attacker.test/collect?d=secret";
    expect(await fb.request({ url, type: "beacon", cookieStoreId: STORE, originUrl: "http://www.bank.test/inbox" })).toBe(true);
    expect(await fb.request({ url: "http://www.bank.test/api", type: "xmlhttprequest", cookieStoreId: STORE })).toBe(false);
    expect(blocked).toEqual([{ loanId: "L1", url, host: "attacker.test", type: "beacon", initiator: "http://www.bank.test/inbox", layer: "webRequest", reason: "not-allowed", at: NOW }]);
  });

  it("E5: the proxy layer sends a blocked host to a dead proxy and reports only what webRequest cannot see", async () => {
    const { fb, blocked } = setup(seeded());
    expect(await fb.proxy({ url: "http://attacker.test/", type: "speculative", cookieStoreId: STORE })).toEqual(DEAD_PROXY);
    expect(await fb.proxy({ url: "http://attacker.test/x", type: "image", cookieStoreId: STORE })).toEqual(DEAD_PROXY);
    expect(await fb.proxy({ url: "http://www.bank.test/", type: "main_frame", cookieStoreId: STORE })).toBeUndefined();
    expect(await fb.proxy({ url: "http://attacker.test/", type: "main_frame", cookieStoreId: "firefox-default" })).toBeUndefined();
    expect(blocked.map((b) => [b.layer, b.type])).toEqual([["proxy", "speculative"]]);
  });

  it("E12: judges a request that comes before the loans are in memory", async () => {
    const { fb } = setup(seeded());
    expect(await fb.request({ url: "http://attacker.test/", type: "image", cookieStoreId: STORE })).toBe(true);
  });

  it("E13: when storage fails, blocks every container but the default and the private one", async () => {
    const fb = fakeBrowser({ stores: seeded() });
    fb.hooks.storageGet = () => {
      throw new Error("storage is broken");
    };
    const { blocked } = setup(undefined, fb);
    expect(await fb.request({ url: "http://www.bank.test/", type: "image", cookieStoreId: STORE })).toBe(true);
    expect(await fb.request({ url: "http://www.bank.test/", type: "image", cookieStoreId: "firefox-container-2" })).toBe(true);
    expect(await fb.request({ url: "http://attacker.test/", type: "image", cookieStoreId: "firefox-default" })).toBe(false);
    expect(await fb.request({ url: "http://attacker.test/", type: "image", cookieStoreId: "firefox-private" })).toBe(false);
    expect(blocked[0]).toMatchObject({ loanId: "unknown", reason: "no-state" });
  });

  it("E14: requests from your own containers pass", async () => {
    const { fb, blocked } = setup(seeded());
    expect(await fb.request({ url: "http://attacker.test/", type: "image", cookieStoreId: "firefox-default" })).toBe(false);
    expect(await fb.request({ url: "http://attacker.test/", type: "image", cookieStoreId: "firefox-container-1" })).toBe(false);
    expect(await fb.request({ url: "http://attacker.test/", type: "image" })).toBe(false);
    expect(blocked).toEqual([]);
  });
});

const cookie = (over: Partial<Cookie>): Cookie => ({
  name: "c", value: "v", domain: "www.bank.test", hostOnly: true, path: "/", secure: false, httpOnly: false,
  sameSite: "lax", session: true, firstPartyDomain: "", partitionKey: null, storeId: "firefox-default", ...over,
});
const USER_COOKIES = [
  cookie({ name: "session", value: "s3cret", httpOnly: true, sameSite: "strict" }),
  cookie({ name: "pref", domain: ".bank.test", hostOnly: false, session: false, expirationDate: NOW / 1000 + 86_400 * 30 }),
  cookie({ name: "mail", domain: "mail.example.com" }),
];
const TASK = { domain: "www.bank.test", scope: "read" as const, ttlMs: 60_000, url: "http://www.bank.test/inbox" };

function lending(extra: Cookie[] = []) {
  const s = setup();
  s.fb.cookies.set("firefox-default", structuredClone([...USER_COOKIES, ...extra]));
  return s;
}

describe("lend", () => {
  it("lends one site: a container, its cookies capped at the loan end, a grant, and a tab", async () => {
    const { fb, host, lender } = lending();
    const loan = await lender.lend(TASK);
    expect(loan).toMatchObject({ state: "active", site: "bank.test", domain: "www.bank.test", containerName: "Agent · bank.test", patterns: ["bank.test", "*.bank.test"], expiresAt: NOW + 60_000, copied: 2, skipped: [], hidden: false });
    expect(fb.containers).toEqual([{ name: "Agent · bank.test", color: "purple", icon: "fingerprint", cookieStoreId: loan.cookieStoreId }]);
    const jar = fb.cookies.get(loan.cookieStoreId!)!;
    expect(jar.map((c) => [c.name, c.httpOnly, c.sameSite, c.expirationDate])).toEqual([
      ["session", true, "strict", (NOW + 60_000) / 1000],
      ["pref", false, "lax", (NOW + 60_000) / 1000],
    ]);
    expect(await host.grants()).toMatchObject([{ id: loan.grantId, scope: "read", domains: ["bank.test", "*.bank.test"], expiresAt: NOW + 60_000 }]);
    expect(fb.tabs).toMatchObject([{ id: loan.tabId, cookieStoreId: loan.cookieStoreId, url: "http://www.bank.test/inbox", active: true }]);
    expect(await lender.listLoans()).toEqual([loan]);
  });

  it("K10: only reads your default container", async () => {
    const { fb, lender } = lending();
    await lender.lend(TASK);
    expect(fb.cookies.get("firefox-default")).toEqual(USER_COOKIES);
    expect(fb.calls.filter((c) => c.includes("firefox-default"))).toEqual([]);
  });

  it("K3: reads partitioned cookies too, and keeps the partition", async () => {
    const key = { topLevelSite: "http://bank.test", hasCrossSiteAncestor: true };
    const { fb, lender } = lending([cookie({ name: "widget", domain: "widget.example.com", partitionKey: key })]);
    const loan = await lender.lend({ ...TASK, allow: ["widget.example.com"] });
    expect(fb.cookies.get(loan.cookieStoreId!)?.find((c) => c.name === "widget")?.partitionKey).toEqual(key);
  });

  it("K12: reports a cookie that Firefox refuses and keeps the loan", async () => {
    const { lender } = lending([cookie({ name: "cross", sameSite: "no_restriction" })]);
    const loan = await lender.lend(TASK);
    expect(loan.state).toBe("active");
    expect(loan.skipped).toMatchObject([{ name: "cross", domain: "www.bank.test", reason: "set-failed" }]);
    expect(loan.skipped[0]?.message).toContain("SameSite=None");
  });

  it("L1: two loans for the same site get their own container and grant", async () => {
    const { lender } = lending();
    const a = await lender.lend(TASK);
    const b = await lender.lend(TASK);
    expect(a.cookieStoreId).not.toBe(b.cookieStoreId);
    expect(a.grantId).not.toBe(b.grantId);
    expect(a.id).not.toBe(b.id);
  });

  it("L3: undoes a lend that fails half way", async () => {
    const { fb } = lending();
    const broken = { addGrant: async () => Promise.reject(new Error("grant store down")), revokeGrant: async () => true };
    const lender = createFoxlend({ browser: fb.browser, host: broken, now: () => NOW });
    expect(await errorCode(lender.lend(TASK))).toBe("lend-failed");
    expect(fb.containers).toEqual([]);
    expect(fb.tabs).toEqual([]);
    expect([...fb.cookies.keys()]).toEqual(["firefox-default"]);
    expect(await lender.listLoans()).toEqual([]);
  });

  it("L10: refuses a TTL that is not a positive finite number, or too long, and a bad scope", async () => {
    const { fb, lender } = lending();
    for (const ttlMs of [0, -1, Number.NaN, Infinity, 24 * 60 * 60 * 1000 + 1]) expect(await errorCode(lender.lend({ ...TASK, ttlMs })), String(ttlMs)).toBe("bad-ttl");
    expect(await errorCode(lender.lend({ ...TASK, scope: "delete" as never }))).toBe("bad-scope");
    expect(await errorCode(lender.lend({ ...TASK, domain: "github.io", url: undefined }))).toBe("bad-domain");
    expect(fb.containers).toEqual([]);
  });

  it("L11: refuses a task URL on a host that the loan blocks", async () => {
    const { fb, lender } = lending();
    expect(await errorCode(lender.lend({ ...TASK, url: "http://attacker.test/" }))).toBe("bad-url");
    expect((await lender.lend({ ...TASK, url: "http://cdn.example.com/", allow: ["cdn.example.com"] })).state).toBe("active");
    expect(fb.containers).toHaveLength(1);
  });

  it("L12: hides the tab when it can, and keeps the loan when it cannot", async () => {
    const { fb, lender } = lending();
    const hidden = await lender.lend({ ...TASK, hidden: true });
    expect(hidden.hidden).toBe(true);
    expect(fb.tabs.find((t) => t.id === hidden.tabId)).toMatchObject({ hidden: true, active: false });
    fb.hooks.tabsHide = () => {
      throw new Error("Missing permission tabHide");
    };
    const shown = await lender.lend({ ...TASK, hidden: true });
    expect(shown).toMatchObject({ state: "active", hidden: false });
    expect(fb.tabs.find((t) => t.id === shown.tabId)).toMatchObject({ hidden: false });
  });
});
