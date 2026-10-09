// Lend one login (docs/failure-modes.md K10, K12, L2, L3, L10-L12), and the
// teardown that both a failed lend and a revoke use (L5, L6).
import type { Host, PublicSuffix, Scope } from "foxgate";
import type { BrowserLike } from "./browser.js";
import { planCopy, type Cookie, type SkippedCookie } from "./cookies.js";
import { judge } from "./egress.js";
import { FoxlendError } from "./errors.js";
import { hostOf, loanPatterns, siteOf } from "./site.js";
import type { Loan, LoanStore } from "./state.js";

export interface LendOptions {
  /** The host to lend, for example `www.example.com`. */
  domain: string;
  /** The foxgate scope of the grant: "read", "fill", "submit", or "pay". */
  scope: Scope;
  /** How long the loan lasts, in ms. */
  ttlMs: number;
  /** More hosts that pages in the loan may reach. Exact hosts or `*.` plus a host. */
  allow?: string[];
  /** The task URL to open. Default: `https://<domain>/`. */
  url?: string;
  /** Hide the loan tab from the tab strip. Needs the `tabHide` permission. */
  hidden?: boolean;
  /** "site" (default): the whole registrable domain. "host": the exact host only. */
  match?: "site" | "host";
  /** The tools that the foxgate grant allows. Default: every tool. */
  tools?: string[];
}

export interface LoanContext {
  browser: BrowserLike;
  host: Pick<Host, "addGrant" | "revokeGrant" | "grants">;
  store: LoanStore;
  now: () => number;
  publicSuffix: PublicSuffix;
  maxTtlMs: number;
  /** Turn off network prediction while a loan is active (E6). */
  stopPrediction: boolean;
}

export const CONTAINER = { prefix: "Agent · ", color: "purple", icon: "fingerprint" } as const;
export const alarmName = (loanId: string) => `foxlend:${loanId}`;
const SCOPES: readonly string[] = ["read", "fill", "submit", "pay"];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cookieUrl = (c: Cookie) => `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`;
const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Give network prediction back when no loan is left (E6, L15). */
export async function givePredictionBack(ctx: LoanContext): Promise<void> {
  if (ctx.stopPrediction && (await ctx.store.loans()).length === 0) await ctx.browser.privacy?.network.networkPredictionEnabled.clear({}).catch(() => false);
}

/** Close the loan tabs, clear and remove the container, and revoke the grant. */
export async function teardown(ctx: LoanContext, loan: Pick<Loan, "cookieStoreId" | "grantId">): Promise<void> {
  const b = ctx.browser;
  const id = loan.cookieStoreId;
  if (id) {
    // Removing a container does not close its tabs (L5). Close them first.
    for (let round = 0; ; round++) {
      const open = (await b.tabs.query({ cookieStoreId: id })).flatMap((t) => (t.id === undefined ? [] : [t.id]));
      if (open.length === 0) break;
      if (round === 5) throw new Error(`Tabs stay open in ${id}.`);
      await b.tabs.remove(open);
    }
    // Only "not found" means gone. Any other error keeps the loan revoking (L13).
    const exists = await b.contextualIdentities.get(id).then(
      () => true,
      (error: unknown) => {
        if (/Invalid contextual identity/.test(message(error))) return false;
        throw error;
      },
    );
    if (exists) {
      // Firefox refuses serviceWorkers with cookieStoreId and then clears nothing (L6).
      await b.browsingData.remove({ cookieStoreId: id }, { cookies: true, localStorage: true, indexedDB: true });
      for (const c of await b.cookies.getAll({ storeId: id, partitionKey: {}, firstPartyDomain: null })) {
        await b.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: id, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}), ...(c.firstPartyDomain ? { firstPartyDomain: c.firstPartyDomain } : {}) });
      }
      await b.contextualIdentities.remove(id);
    }
  }
  if (loan.grantId) await ctx.host.revokeGrant(loan.grantId);
}

export async function lendLoan(ctx: LoanContext, options: LendOptions): Promise<Loan> {
  const { browser: b, publicSuffix } = ctx;
  if (!SCOPES.includes(options.scope)) throw new FoxlendError("bad-scope", `The scope must be one of ${SCOPES.join(", ")}.`);
  const { ttlMs } = options;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > ctx.maxTtlMs) {
    throw new FoxlendError("bad-ttl", `ttlMs must be a number above 0 and at most ${ctx.maxTtlMs}.`);
  }
  const match = options.match ?? "site";
  const domain = hostOf(options.domain);
  const site = siteOf(domain, publicSuffix);
  const allow = options.allow ?? [];
  const patterns = loanPatterns({ host: domain, match, allow, publicSuffix });
  const url = options.url ?? `https://${domain}/`;
  const probe = { id: "probe", cookieStoreId: "probe", patterns, expiresAt: Infinity, state: "active" as const };
  if (judge({ url, type: "main_frame", cookieStoreId: "probe" }, [probe], 0, publicSuffix).block) {
    throw new FoxlendError("bad-url", `${url} is not on the loan allow list (${patterns.join(", ")}).`);
  }

  return ctx.store.serial(async () => {
    const createdAt = ctx.now();
    let loan: Loan = {
      id: randomId(),
      state: "creating",
      patterns,
      expiresAt: createdAt + ttlMs,
      domain,
      site,
      scope: options.scope,
      match,
      allow,
      url,
      createdAt,
      containerName: `${CONTAINER.prefix}${site}`,
      hidden: false,
      copied: 0,
      skipped: [],
    };
    const put = async (patch: Partial<Loan>) => {
      loan = { ...loan, ...patch };
      await ctx.store.save([...(await ctx.store.loans()).filter((l) => l.id !== loan.id), loan]);
    };
    // The record exists before the container, so a crash cannot hide a container (L2).
    await put({});
    try {
      const container = await b.contextualIdentities.create({ name: loan.containerName, color: CONTAINER.color, icon: CONTAINER.icon });
      await put({ cookieStoreId: container.cookieStoreId });
      // Only read the default container (K10). firstPartyDomain null matches all (K9).
      const source = await b.cookies.getAll({ storeId: "firefox-default", partitionKey: {}, firstPartyDomain: null });
      const plan = planCopy(source, { host: domain, match, patterns, storeId: container.cookieStoreId, endsAt: loan.expiresAt, now: createdAt, publicSuffix });
      const skipped: SkippedCookie[] = [...plan.skipped];
      let copied = 0;
      for (const details of plan.set) {
        try {
          await b.cookies.set(details);
          copied++;
        } catch (error) {
          skipped.push({ name: details.name, domain: details.domain ?? new URL(details.url).hostname, reason: "set-failed", message: message(error) });
        }
      }
      await put({ grantRequested: true });
      const grant = await ctx.host.addGrant({ scope: options.scope, domains: patterns, expiresAt: loan.expiresAt, ...(options.tools ? { tools: options.tools } : {}) });
      // Save the grant ID before any other step, so the undo can revoke it (L16).
      await put({ grantId: grant.id });
      b.alarms.create(alarmName(loan.id), { when: loan.expiresAt });
      await put({ state: "active", copied, skipped });
      // DNS prefetch is outside both guard layers (E6). A setting that another extension controls stays as it is.
      if (ctx.stopPrediction) await b.privacy?.network.networkPredictionEnabled.set({ value: false }).catch(() => false);
      const tab = await b.tabs.create({ url, cookieStoreId: container.cookieStoreId, active: !options.hidden });
      let hidden = false;
      if (options.hidden && tab.id !== undefined) hidden = await b.tabs.hide([tab.id]).then(() => true, () => false);
      await put({ ...(tab.id === undefined ? {} : { tabId: tab.id }), hidden });
      return structuredClone(loan);
    } catch (error) {
      // Undo what is done (L3). If the undo fails too, the guard keeps blocking and the next sweep retries.
      try {
        await teardown(ctx, loan);
        await ctx.store.save((await ctx.store.loans()).filter((l) => l.id !== loan.id));
        await givePredictionBack(ctx);
      } catch {
        await put({ state: "revoking" }).catch(() => undefined);
      }
      throw new FoxlendError("lend-failed", `The loan for ${domain} failed and was undone: ${message(error)}`, { cause: error });
    }
  });
}
