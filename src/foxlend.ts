// createFoxlend() wires the guard, lend, revoke, alarms, and the start sweep.
import type { Host, PublicSuffix } from "foxgate";
import { emitter, type BrowserLike, type Listenable } from "./browser.js";
import { attachGuard, type BlockedRequest } from "./guard.js";
import { lendLoan, type LendOptions, type LoanContext } from "./lend.js";
import { revokeNow, sweepNow, type RevokedEvent } from "./revoke.js";
import { withDefaultRule } from "./site.js";
import { loanStore, type Loan } from "./state.js";

export interface FoxlendOptions {
  /** The WebExtension `browser` object. */
  browser: BrowserLike;
  /** The foxgate host. foxlend adds one grant per loan and revokes it with the loan. */
  host: Pick<Host, "addGrant" | "revokeGrant">;
  /** Default: withDefaultRule(browser.publicSuffix). Give foxgate the same object. */
  publicSuffix?: PublicSuffix;
  /** The clock, in ms since 1970. Default: Date.now. */
  now?: () => number;
  /** The longest loan, in ms. Default: 24 hours. */
  maxTtlMs?: number;
  /** Also block through proxy.onRequest. Default: true when `browser.proxy` exists. */
  proxyLayer?: boolean;
  /** Turn off network prediction while a loan is active. Default: true when `browser.privacy` exists. */
  stopPrediction?: boolean;
  /** The browser.storage.local key. Default: "foxlend". */
  storageKey?: string;
}

export interface Foxlend {
  lend(options: LendOptions): Promise<Loan>;
  /** Returns false when there is no such loan. Throws FoxlendError `revoke-failed` when a step fails. */
  revoke(loan: Loan | string): Promise<boolean>;
  listLoans(): Promise<Loan[]>;
  /** Revoke loans whose time is over, and remove containers that no loan holds. foxlend runs it at start. */
  sweep(): Promise<void>;
  onBlocked: Listenable<BlockedRequest>;
  onRevoked: Listenable<RevokedEvent>;
}

/**
 * Call this at the top level of the background script, so Firefox can wake
 * the event page for a request, an alarm, or a browser start.
 */
export function createFoxlend(options: FoxlendOptions): Foxlend {
  const { browser } = options;
  const publicSuffix = options.publicSuffix ?? (browser.publicSuffix ? withDefaultRule(browser.publicSuffix) : undefined);
  if (!publicSuffix) throw new TypeError("foxlend needs a public suffix list: Firefox 153+ with the publicSuffix permission, or the publicSuffix option.");
  const store = loanStore(browser, options.storageKey ?? "foxlend");
  const blocked = emitter<BlockedRequest>();
  const revoked = emitter<RevokedEvent>();
  const ctx: LoanContext = {
    browser,
    host: options.host,
    store,
    now: options.now ?? Date.now,
    publicSuffix,
    maxTtlMs: options.maxTtlMs ?? 24 * 60 * 60 * 1000,
    stopPrediction: options.stopPrediction ?? browser.privacy !== undefined,
  };
  attachGuard({ browser, store, now: ctx.now, publicSuffix, proxyLayer: options.proxyLayer ?? browser.proxy !== undefined, onBlocked: blocked.emit });
  const revoke = (id: string, reason: RevokedEvent["reason"]) => store.serial(() => revokeNow(ctx, id, reason, revoked.emit));
  const sweep = () => store.serial(() => sweepNow(ctx, revoked.emit));
  browser.alarms.onAlarm.addListener(({ name }) => {
    if (name.startsWith("foxlend:")) revoke(name.slice("foxlend:".length), "ttl").catch(() => undefined);
  });
  browser.runtime.onStartup.addListener(() => void sweep().catch(() => undefined));
  sweep().catch(() => undefined);
  return Object.freeze({
    lend: (lendOptions: LendOptions) => lendLoan(ctx, lendOptions),
    revoke: (loan: Loan | string) => revoke(typeof loan === "string" ? loan : loan.id, "user"),
    listLoans: async () => structuredClone(await store.loans()),
    sweep,
    onBlocked: blocked.event,
    onRevoked: revoked.event,
  });
}
