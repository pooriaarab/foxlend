# Failure modes

This file lists every way a foxlend part can fail. Each failure mode has a
test or an E2E check. The test comes first, then the code.

foxlend lends one login to an AI agent. A failure here gives the agent more
than one site, lets a page send your data to a host you did not allow, or
leaves the login with the agent after you take it back. So every part fails
closed: when foxlend is not sure, it blocks the request or refuses the loan.

The tests in `tests/` run in Node. They use a stand-in for the parts of the
`browser` object that foxlend calls. The E2E test (`e2e/run.mjs`) runs the
same flow in a real Firefox and checks the Firefox behavior that a stand-in
cannot prove.

## Sites

A loan is for one site: the registrable domain (eTLD+1) of the host you lend.

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| S1 | Firefox `publicSuffix.getDomain` returns `null` for a host on a top-level domain that is not on the list (`www.bank.test`, `bank.localhost`). | Use the default rule of the public suffix list: when `getKnownSuffix` is also `null`, the site is the last two labels. | `tests/site.test.ts` |
| S2 | The host is a public suffix (`github.io`, `co.uk`). `getDomain` returns `null` for it too. | Refuse the loan with `bad-domain`. The default rule applies only when no known suffix matches. | `tests/site.test.ts` |
| S3 | The host is an IP address. | The site is the address itself. No `*.` pattern is made for it. | `tests/site.test.ts` |
| S4 | The domain has a scheme, a port, a path, or spaces. | Refuse with `bad-domain`. Give a host only. | `tests/site.test.ts` |
| S5 | The host has uppercase letters, a trailing dot, or Unicode. | Normalize to lowercase punycode with no trailing dot. | `tests/site.test.ts` |

## Cookie copy

foxlend reads the cookies of your default container and copies some of them
into the loan container. It never writes to your default container.

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| K1 | Cookies from sibling sites under a shared public suffix leak: a loan for `alice.github.io` copies the cookies of `bob.github.io`. | Copy a cookie only when its domain is the site or a subdomain of the site, by whole labels. | `tests/cookies.test.ts` |
| K2 | Look-alike domains leak: `evilbank.test` or `bank.test.evil.example` for a loan of `bank.test`. | No copy. Matching is by whole labels. | `tests/cookies.test.ts` |
| K3 | A partitioned cookie is missed. A sign-in widget on the site stores its cookie in the site's partition (Total Cookie Protection), and the agent is not signed in. | Read with `partitionKey: {}`. Copy a partitioned cookie when its `topLevelSite` is the lent site and its domain is the site or on the allow list. | `tests/cookies.test.ts`, E2E |
| K4 | A partitioned cookie leaks: the site's cookie from the partition of another top-level site is copied. | No copy. It belongs to the other site. | `tests/cookies.test.ts` |
| K5 | A partitioned cookie becomes a first-party cookie in the loan, because the copy drops `partitionKey`. | Keep `partitionKey` as it is. | `tests/cookies.test.ts`, E2E |
| K6 | `HttpOnly`, `Secure`, `SameSite`, the path, or host-only is lost. A page script could then read a session cookie, or a host-only cookie goes to all subdomains. | Keep each flag. A host-only cookie is set with no `domain`. | `tests/cookies.test.ts`, E2E |
| K7 | Expiry is not capped. A copied cookie stays valid after the loan ends, also when the extension is gone. | The copy expires at the earlier of its own expiry and the loan end. A session cookie gets the loan end. This caps the copies only: a cookie that the site sets in the loan container during the loan is not capped (see L4). | `tests/cookies.test.ts`, E2E |
| K8 | A cookie that has expired is copied. | No copy. | `tests/cookies.test.ts` |
| K9 | First-party isolation is on. `cookies.getAll` and `cookies.set` fail without `firstPartyDomain`. | Read with `firstPartyDomain: null`, which matches all, and set each copy with its own `firstPartyDomain`. | `tests/cookies.test.ts` |
| K10 | Your own session is changed: the copy writes to, or removes from, your default container, and you are logged out. | Only read the default container. A loan and its revoke leave your cookies byte for byte the same. | `tests/loans.test.ts`, E2E |
| K11 | With `match: "host"`, a cookie that the lent host never receives is copied (a host-only cookie of `mail.bank.test` for a loan of `www.bank.test`). | Copy only the cookies that the browser sends to that host: its host-only cookies and the domain cookies of the host and its parents inside the site. | `tests/cookies.test.ts` |
| K13 | With `match: "host"`, a partitioned cookie of another subdomain in the site partition is copied (`mail.bank.test` for a loan of `www.bank.test`). | Apply the same host rule to partitioned cookies whose domain is in the site. | `tests/cookies.test.ts` |
| K14 | First-party isolation is on, and the site's cookie from another first party (`firstPartyDomain: "evil.example"`) is copied. | Skip a cookie whose `firstPartyDomain` is set and is not the site, with reason `other-partition`. | `tests/cookies.test.ts` |
| K12 | Firefox refuses one copy (for example a `Secure` cookie for an `http:` URL). | Do not stop the loan. Report the cookie in `loan.skipped` with the reason. | `tests/loans.test.ts` |

## Egress allow list

A page in the loan container can reach only the lent site and the hosts on
the allow list. This is the main guard against a prompt injection that tells
the agent to send your data somewhere else.

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| E1 | A page in the loan container sends a request to a host that is not on the list. | Cancel it. Report it on `onBlocked` with the URL, the request type, and the initiator. | `tests/egress.test.ts`, E2E |
| E2 | A look-alike host passes: `bank.test.evil.example`, `evilbank.test`, uppercase, a trailing dot, or a Unicode name. | Normalize the host, then match by whole labels. | `tests/egress.test.ts` |
| E3 | An allowed host redirects to a blocked host. | Judge the new URL too. Firefox fires `onBeforeRequest` again for the redirect target. | E2E |
| E4 | A request that is not a page load passes: a WebSocket, a beacon, a prefetch, an image, or a `fetch` from a service worker. | The listener has no type filter, so the same rule applies to every type. | E2E |
| E5 | A speculative connection (`<link rel="preconnect">`) opens a TCP connection to a blocked host. `webRequest` never sees it. | A second layer: `proxy.onRequest` sends a request from a loan container to a blocked host to a SOCKS proxy that does not exist, with `proxyDNS`. Firefox then makes no DNS lookup and no connection. | E2E |
| E6 | A DNS prefetch (`<link rel="dns-prefetch">`) puts data in a host name that goes to a DNS server. Neither layer sees it. | Turn off network prediction while a loan is active, and give the setting back when the last loan ends. The setting also stops link prefetch. It does not stop `<link rel="preconnect">` (seen in Firefox 157), so E5 is still needed. | `tests/loans.test.ts`, E2E |
| E7 | DNS rebinding: an allowed host name starts to resolve to another address. | Not detected. The allow list trusts the DNS of the hosts on it. An IP address or `localhost` is blocked unless it is on the list exactly. This is a documented limit. | `tests/egress.test.ts` |
| E8 | A request uses a scheme other than `http`, `https`, `ws`, or `wss`. | Cancel it. `data:`, `blob:`, and `about:` pass, because they do not leave the browser. | `tests/egress.test.ts` |
| E9 | The URL does not parse, or the host is an IPv6 address. | Cancel it. | `tests/egress.test.ts` |
| E10 | The loan has expired, but its alarm has not run yet. | Cancel every request from that container. | `tests/egress.test.ts` |
| E11 | A request starts while the loan is being revoked. | Cancel every request from that container from the first step of the revoke. | `tests/egress.test.ts`, `tests/loans.test.ts` |
| E12 | The event page was unloaded, so the loan list is not in memory when a request comes. | Wait for the list from storage before the answer. Never let a request pass without a judgment. | `tests/loans.test.ts` |
| E13 | The loan list cannot be read from storage. | Cancel every request from any container other than the default and the private one. | `tests/loans.test.ts` |
| E14 | The guard blocks your own tabs. | Only requests with the `cookieStoreId` of a loan are judged. The default container and other containers pass. | E2E |
| E16 | `judge()` throws: a stored pattern no longer parses (the public suffix list changed), or a loan record is damaged. Firefox lets a request pass when a blocking listener throws. | A pattern that does not parse matches nothing. Any other error in the guard blocks the request with reason `error`. Found in review after the guard PR. | `tests/egress.test.ts`, `tests/loans.test.ts` |
| E15 | The `webRequest` filter cannot select one container (Firefox 157 refuses a `cookieStoreId` filter). | Listen to all URLs and read `details.cookieStoreId` in the listener. | E2E |

## Loans

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| L1 | Two loans for the same site share a container or a grant, so one revoke breaks the other loan or misses part of it. | Each loan gets its own container, grant, and alarm. A revoke touches only its own loan. | `tests/loans.test.ts` |
| L2 | Firefox stops between the container create and the record write, so a container is left behind. | Write the loan record before the create, and the `cookieStoreId` right after. At start, revoke records that never became active, and remove containers with the foxlend name, color, and icon that no record holds. | `tests/loans.test.ts` |
| L3 | A lend fails half way (a cookie read, the grant, or the tab). | Undo the steps done so far: the container, the cookies, and the grant. Then throw. | `tests/loans.test.ts` |
| L4 | The TTL alarm does not run because Firefox was closed. | At start, revoke every loan whose time is over. The copied cookies have already expired (K7), and the guard blocks the container (E10). New cookies that the site set during the loan stay until this revoke. This is a documented limit. | `tests/loans.test.ts` |
| L5 | Removing a container does not close its tabs (seen in Firefox 157). The tab stays open in a container that no longer exists. | Close the tabs first. Query again until no tab is left, then remove the container. | `tests/loans.test.ts`, E2E |
| L6 | `browsingData.remove` throws when it is asked to clear service workers for one container, and then clears nothing. | Ask only for cookies, local storage, and IndexedDB. Service workers are a documented limit. | `tests/loans.test.ts`, E2E |
| L7 | A revoke step fails. | Keep the loan in the `revoking` state, so the guard still blocks it. Throw. The next start tries the revoke again. | `tests/loans.test.ts` |
| L8 | `revoke` runs two times, or for an unknown ID. | The second call does nothing and returns `false`. | `tests/loans.test.ts` |
| L9 | The foxgate grant stays after the loan. | Revoke the grant with the loan. The grant also expires at the loan end. | `tests/loans.test.ts` |
| L10 | The TTL is not a positive finite number, or it is longer than `maxTtlMs`. | Refuse with `bad-ttl`. | `tests/loans.test.ts` |
| L11 | The task URL is on a host that the loan blocks. | Refuse with `bad-url`. The agent could not use it. | `tests/loans.test.ts` |
| L13 | `contextualIdentities.get` fails for a reason other than "not found" during a revoke. The revoke then skips the clear and the remove, and deletes the record of a container that still exists. | Treat only the Firefox "Invalid contextual identity" error as "gone". Throw for any other error, so the loan stays `revoking`. | `tests/loans.test.ts` |
| L14 | Firefox stops after `addGrant` and before the loan record holds the grant ID, so a foxgate grant stays that no record names. | Write `grantRequested: true` in the record before `addGrant`. At start, for a record that never became active, find its grant by the same scope, domains, and end time, and revoke it. A grant that the app made itself does not match, and it stays. Found in review. | `tests/loans.test.ts` |
| L16 | A lend step fails after `addGrant` returns and before the record holds the grant ID (for example `alarms.create` throws). The undo then runs without the grant ID, and the grant stays. | Save the grant ID in the record at once after `addGrant`, before any other step. Found in review. | `tests/loans.test.ts` |
| L15 | A lend fails after it turned network prediction off, so the setting stays off with no loan. | The undo path gives the setting back when no loan is left. The start sweep gives it back too when no loan is active. Found in review. | `tests/loans.test.ts` |
| L12 | `tabs.hide` fails, for example without the `tabHide` permission. | Keep the loan, open the tab, and set `loan.hidden` to `false`. | `tests/loans.test.ts` |

## End to end

`e2e/run.mjs` serves a test bank site on `www.bank.localhost` and an attacker
on `attacker.test`, all mapped to `127.0.0.1`. Puppeteer does not see tabs
in a container made after it started, so the test reads the bank server log
and takes loan tab screenshots with `tabs.captureTab`. It checks the full flow in a
real Firefox and writes `artifacts/e2e-<date>.json`.

| # | Check |
|---|---|
| X1 | You log in to the bank in your default container. |
| X2 | Lend: the loan container exists, and its tab shows the bank page logged in. |
| X3 | The copied session cookie keeps `HttpOnly` and `SameSite`, and expires by the loan end. |
| X4 | The partitioned cookie of the bank's widget is in the loan, still partitioned. The bank's cookie from another site's partition is not. |
| X5 | A page with a hidden prompt injection tries to send data to `attacker.test` in many ways. Each one is blocked and reported. The attacker server gets no request and no connection. |
| X6 | Your own default tab can still reach `attacker.test`. |
| X7 | Revoke: the container, its tab, and its cookies are gone. Your own tab is still logged in, and your cookies did not change. |
| X8 | A loan with a 3 second TTL and a hidden tab ends at its alarm, and its container is gone. |
