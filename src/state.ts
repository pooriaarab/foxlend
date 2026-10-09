// Where loans live: one record in browser.storage.local, with a copy in
// memory. The event page can unload at any time, so the record is the truth.
import type { Scope } from "foxgate";
import type { BrowserLike } from "./browser.js";
import type { SkippedCookie } from "./cookies.js";
import type { LoanState } from "./egress.js";
import { FoxlendError } from "./errors.js";

/** One login lent to an agent. */
export interface Loan extends LoanState {
  /** The lent host, lowercase punycode. */
  domain: string;
  /** The registrable domain of `domain`. */
  site: string;
  scope: Scope;
  match: "site" | "host";
  allow: string[];
  /** The task URL that the loan tab opened. */
  url: string;
  createdAt: number;
  containerName: string;
  grantId?: string;
  /** Set before addGrant, so the start sweep can find a grant that a crash left without a record (L14). */
  grantRequested?: boolean;
  tabId?: number;
  hidden: boolean;
  /** The number of cookies copied into the loan container. */
  copied: number;
  skipped: SkippedCookie[];
}

export interface LoanStore {
  /** The loans in memory, or undefined before the first read. */
  cached(): Loan[] | undefined;
  /** Read the loans. Undefined when storage fails. */
  load(): Promise<Loan[] | undefined>;
  /** Read the loans. Throws FoxlendError `storage-error` when storage fails. */
  loans(): Promise<Loan[]>;
  /** The IDs of removed loan containers. The guard blocks them for good (L17). */
  retired(): string[];
  /** Add a container ID to the retired list and save it. */
  retire(cookieStoreId: string): Promise<void>;
  /** The memory copy changes first, so the guard sees a new state at once. */
  save(loans: Loan[]): Promise<void>;
  /** Run state changes one at a time. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
}

export function loanStore(browser: BrowserLike, key: string): LoanStore {
  let cache: Loan[] | undefined;
  let retired: string[] = [];
  let loading: Promise<Loan[] | undefined> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const read = async () => {
    try {
      const record = (await browser.storage.local.get(key))[key] as { loans?: unknown; retired?: unknown } | undefined;
      if (!cache && Array.isArray(record?.retired)) retired = record.retired.filter((id): id is string => typeof id === "string");
      cache ??= Array.isArray(record?.loans) ? (record.loans as Loan[]) : [];
      return cache;
    } catch {
      return undefined;
    } finally {
      loading = undefined;
    }
  };
  const store: LoanStore = {
    cached: () => cache,
    load: () => (cache ? Promise.resolve(cache) : (loading ??= read())),
    async loans() {
      const loans = await store.load();
      if (!loans) throw new FoxlendError("storage-error", "foxlend cannot read its loans from browser.storage.local.");
      return loans;
    },
    retired: () => retired,
    async retire(cookieStoreId) {
      const loans = await store.loans();
      // Firefox did not use a removed container ID again in our tests. Keep the last 200.
      retired = [...retired.filter((id) => id !== cookieStoreId), cookieStoreId].slice(-200);
      await browser.storage.local.set({ [key]: { loans, retired } });
    },
    async save(loans) {
      cache = loans;
      await browser.storage.local.set({ [key]: { loans, retired } });
    },
    serial(fn) {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },
  };
  return store;
}
