// Failure modes for the guard wiring and the loan life cycle in
// docs/failure-modes.md. The stand-in browser copies the Firefox behavior
// that each failure mode names. e2e/run.mjs checks the same in Firefox.
import { describe, expect, it } from "vitest";
import { createFoxlend, DEAD_PROXY, type BlockedRequest } from "../src/index.js";
import { fakeBrowser } from "./fake-browser.js";

const NOW = 1_800_000_000_000;
const STORE = "firefox-container-9";

function setup(stores?: Record<string, unknown>, fb = fakeBrowser({ stores })) {
  const clock = { now: NOW };
  const lender = createFoxlend({ browser: fb.browser, now: () => clock.now });
  const blocked: BlockedRequest[] = [];
  lender.onBlocked.addListener((e) => blocked.push(e));
  return { fb, lender, blocked, clock };
}

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
