// Take a login back (docs/failure-modes.md L1, L4-L9, E6, E11), and the
// sweep that runs when foxlend starts (L2, L4).
import type { Loan } from "./state.js";
import { alarmName, CONTAINER, hasHostAccess, releaseSettings, teardown, type LoanContext } from "./lend.js";
import { FoxlendError } from "./errors.js";

/** Why a loan ended. "startup": a loan that never became active, or a revoke that failed before. */
export interface RevokedEvent {
  loan: Loan;
  reason: "user" | "ttl" | "startup" | "permission";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The grant of a record that asked for one and never got its ID (L14): same
 * scope, domains, and end time, and no other loan holds it.
 */
async function lostGrant(ctx: LoanContext, loan: Loan, loans: Loan[]): Promise<string | undefined> {
  const held = new Set(loans.map((l) => l.grantId));
  const same = (domains: string[]) => JSON.stringify(domains) === JSON.stringify(loan.patterns);
  return (await ctx.host.grants()).find((g) => !held.has(g.id) && g.scope === loan.scope && g.expiresAt === loan.expiresAt && same(g.domains))?.id;
}

/** Revoke one loan. Call it inside store.serial(). */
export async function revokeNow(ctx: LoanContext, id: string, reason: RevokedEvent["reason"], emit: (event: RevokedEvent) => void): Promise<boolean> {
  const loans = await ctx.store.loans();
  const found = loans.find((l) => l.id === id);
  if (!found) return false;
  // The guard blocks the container from this line on (E11).
  const grantId = found.grantId ?? (found.grantRequested ? await lostGrant(ctx, found, loans) : undefined);
  const loan: Loan = { ...found, state: "revoking", ...(grantId ? { grantId } : {}) };
  await ctx.store.save(loans.map((l) => (l.id === id ? loan : l)));
  try {
    await teardown(ctx, loan);
    await ctx.browser.alarms.clear(alarmName(id));
  } catch (error) {
    throw new FoxlendError("revoke-failed", `The loan for ${loan.domain} is not fully revoked: ${message(error)}. Its requests stay blocked, and the next start tries again.`, { cause: error });
  }
  await ctx.store.save((await ctx.store.loans()).filter((l) => l.id !== id));
  await releaseSettings(ctx);
  emit({ loan, reason });
  return true;
}

/**
 * Revoke loans whose time is over or that never became active, set the
 * alarms again for the others, and remove foxlend containers that no loan
 * holds. Call it inside store.serial().
 */
export async function sweepNow(ctx: LoanContext, emit: (event: RevokedEvent) => void): Promise<void> {
  const now = ctx.now();
  // Without access to all sites the guard sees nothing, so no loan may stay (E19).
  const blind = !(await hasHostAccess(ctx));
  for (const loan of await ctx.store.loans()) {
    const expired = loan.expiresAt <= now;
    if (blind || expired || loan.state !== "active") {
      await revokeNow(ctx, loan.id, blind ? "permission" : expired ? "ttl" : "startup", emit).catch(() => false);
    } else {
      ctx.browser.alarms.create(alarmName(loan.id), { when: loan.expiresAt });
    }
  }
  const held = new Set((await ctx.store.loans()).map((l) => l.cookieStoreId));
  for (const c of await ctx.browser.contextualIdentities.query({})) {
    const ours = c.name.startsWith(CONTAINER.prefix) && c.color === CONTAINER.color && c.icon === CONTAINER.icon;
    if (ours && !held.has(c.cookieStoreId)) await teardown(ctx, { cookieStoreId: c.cookieStoreId }).catch(() => undefined);
  }
  await releaseSettings(ctx);
}
