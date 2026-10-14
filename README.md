# foxlend

[![npm version](https://img.shields.io/npm/v/foxlend)](https://www.npmjs.com/package/foxlend)
[![Downloads per month](https://img.shields.io/npm/dm/foxlend)](https://www.npmjs.com/package/foxlend)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/foxlend) · [Setup](#lend-your-first-login) · [API](#api) · [Issues](https://github.com/pooriaarab/foxlend/issues)

foxlend is an open-source Firefox WebExtension library for lending one site's login cookies to an AI agent in a separate container.
It copies cookies, adds a foxgate grant, and filters requests against allowed hosts.
Revocation closes loan tabs, clears supported site data, removes the container, and revokes the grant.

## Install

```bash
npm install foxlend foxgate
```

foxlend has one direct runtime dependency, foxgate. Node.js 24 or later is the declared build environment.
Runtime requires desktop Firefox extension APIs; the included extension requires Firefox 153 or later.
There are no service credentials or environment variables. The package does not load `.env` files.

## Lend your first login

Create `extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Loan example",
  "version": "1.0.0",
  "browser_specific_settings": { "gecko": { "id": "loan@example.org", "strict_min_version": "153.0" } },
  "permissions": ["storage", "alarms", "cookies", "contextualIdentities", "browsingData", "tabs", "webRequest", "webRequestBlocking", "proxy", "privacy", "publicSuffix"],
  "host_permissions": ["<all_urls>"],
  "background": { "scripts": ["background.js"] }
}
```

Save this as `background.js` outside `extension/`:

```js
import { createFoxgate } from "foxgate";
import { createFoxlend, withDefaultRule } from "foxlend";

const publicSuffix = withDefaultRule(browser.publicSuffix);
const { gate, host } = createFoxgate({ tools: { read_page: "read" }, publicSuffix });
const lender = createFoxlend({ browser, host, publicSuffix });
lender.onBlocked.addListener((event) => console.log("blocked", event.url));

async function example() {
  const loan = await lender.lend({ domain: "www.example.com", scope: "read", ttlMs: 60_000 });
  try {
    console.log("container", loan.containerName, "cookies copied", loan.copied);
    const action = { tool: "read_page", args: {}, domain: "www.example.com", scope: "read" };
    console.log("decision", (await gate.check(action)).decision);
  } finally {
    console.log("revoked", await lender.revoke(loan));
  }
}
example().catch(console.error);
```

Bundle the background script:

```bash
npx esbuild background.js --bundle --format=iife --outfile=extension/background.js
```

Open `about:debugging#/runtime/this-firefox`, then load the manifest as a temporary add-on.
Inspect its background console. Expect `decision allow` and `revoked true` after the container message.
The example domain needs no login. Replace it with your test host after signing in through the default container.
A loan can succeed with zero copied cookies; check `copied` and `skipped` for your site's session.

## How it works

```text
lend -> save loan -> create container -> copy cookies -> foxgate grant -> task tab
requests -> host allow list -> webRequest cancel + optional proxy guard
revoke / expiry / startup -> block -> close tabs -> clear data -> remove container -> revoke grant
```

Each loan has a time to live (TTL), with a default maximum of 24 hours.
An alarm revokes expired loans. Startup sweeps retry unfinished cleanup and remove orphaned loan containers.
Cookie copies preserve supported attributes and expire no later than the loan end.
By default, active loans disable network prediction and WebRTC across Firefox.

## Why it exists

Firefox containers separate cookie stores. An agent also needs explicit loan expiry, cookie transfer, and allowed request hosts.
foxlend combines these steps with foxgate grants in an extension library.
Mozilla Multi-Account Containers and Temporary Containers address other container workflows.
Do not combine tab-moving container extensions with loan enforcement; see the limits below.

## Compare

Checked 2026-10-14 against source and the linked project descriptions.

| Property | foxlend | [Mozilla Multi-Account Containers](https://github.com/mozilla/multi-account-containers) | [Temporary Containers](https://github.com/stoically/temporary-containers) |
|---|---|---|---|
| Main scope | Timed login loans for agents | Separate browser identities | Disposable browser containers |
| Surface | Extension library and demo sidebar | Firefox add-on | Firefox add-on |
| Configuration | JavaScript loan options | Add-on controls | Add-on preferences |
| Loan lifecycle | `lend`, alarm, `revoke`, startup sweep | Identity containers | Automatic container disposal |

## Coverage

| Integration | Status | Role |
|---|---|---|
| Mozilla Firefox desktop | Implemented | Containers, cookies, request guards, alarms, privacy settings |
| foxgate | Implemented | Matching host grants and four scopes: `read`, `fill`, `submit`, `pay` |
| Chrome / Chromium | — | No runtime adapter |
| Firefox for Android | — | Required container APIs unavailable |

There are two implemented integrations and two request guard layers in source.
The proxy layer is optional and defaults on when the API exists.
Local tests use browser stand-ins. This rewrite does not claim a new real-browser or credentialed service check.

## Common use cases

1. Firefox agent authors: lend a test account and check each action through foxgate.
2. Quality engineers: use exact-host loans for a staging site in desktop Firefox.
3. Client tooling authors: create separate Firefox cookie stores for client account tasks.
4. Security researchers: test off-list request blocking with the included Firefox fixture sites.

## Features

- **Cookie transfer:** copies eligible default-container cookies with capped expiry and reports skipped copies.
- **Host control:** supports site-wide or exact-host matching, plus explicit allowed hosts.
- **Revocation:** combines manual cleanup, TTL alarms, and startup recovery.
- **Events:** reports blocked requests and completed revocations.
- **Demo sidebar:** lists loans and blocked requests in the bundled extension.

## Runtime surfaces

foxlend runs in a Firefox background script. Register one lender at the top level.
It has no CLI or Model Context Protocol (MCP) server and exports no MCP tools.

### API

This package is a library only. It has no CLI and no MCP server, because
every part needs WebExtension APIs that exist only inside Firefox.

### `createFoxlend(options)`

Call it at the top level of the background script. It returns a frozen
object.

| Option | Default | What it does |
|---|---|---|
| `browser` | required | The WebExtension `browser` object. |
| `host` | required | The foxgate `host`. foxlend calls `addGrant`, `revokeGrant`, and `grants`. |
| `publicSuffix` | `withDefaultRule(browser.publicSuffix)` | Finds the site of a host. Give foxgate the same object. |
| `now` | `Date.now` | The clock, in ms since 1970. |
| `maxTtlMs` | 24 hours | The longest loan. |
| `proxyLayer` | `true` when `browser.proxy` exists | Add the `proxy.onRequest` layer. |
| `stopPrediction` | `true` | Turn off network prediction while a loan is active. When foxlend cannot, `lend` throws `setting-failed`. `false` accepts the risk. |
| `stopWebRtc` | `true` | Turn off WebRTC while a loan is active. When foxlend cannot, `lend` throws `setting-failed`. `false` accepts the risk. |
| `storageKey` | `"foxlend"` | The `browser.storage.local` key for the loans. |

### The lender

| Member | What it does |
|---|---|
| `lend(options)` | Lends one login and returns the `Loan`. Throws a `FoxlendError`. |
| `revoke(loanOrId)` | Takes the login back. Returns `false` when there is no such loan. |
| `listLoans()` | The active loans, and loans that wait for a revoke to finish. |
| `sweep()` | Revokes loans whose time is over and removes foxlend containers that no loan holds. foxlend runs it at start. |
| `onBlocked` | `addListener(fn)`. `fn` gets `{ loanId, url, host, type, initiator, layer, reason, at }`. |
| `onRevoked` | `addListener(fn)`. `fn` gets `{ loan, reason }`. `reason` is `user`, `ttl`, `startup`, or `permission`. |

### `lend` options

| Option | Default | What it does |
|---|---|---|
| `domain` | required | The host to lend, for example `www.example.com`. |
| `scope` | required | The foxgate scope of the grant: `read`, `fill`, `submit`, or `pay`. |
| `ttlMs` | required | How long the loan lasts, in ms. |
| `allow` | `[]` | More hosts that pages in the loan may reach: exact hosts, or `*.` plus a host. |
| `url` | `https://<domain>/` | The task URL. It must be on a host that the loan allows. |
| `hidden` | `false` | Hide the task tab. Needs the `tabHide` permission. |
| `match` | `"site"` | `"site"` lends the registrable domain and its subdomains. `"host"` lends the exact host only, with only the cookies that host gets. |
| `tools` | every tool | The tool names that the foxgate grant allows. |

A `Loan` has these fields:

| Field | What it is |
|---|---|
| `id`, `state` | The loan ID, and `creating`, `active`, or `revoking`. |
| `domain`, `site`, `match` | The lent host, its registrable domain, and the match mode. |
| `patterns` | The allow list: the lent site and the `allow` hosts. |
| `scope`, `grantId` | The foxgate scope and the ID of the grant. |
| `cookieStoreId`, `containerName` | The loan container. |
| `url`, `tabId`, `hidden` | The task tab. |
| `createdAt`, `expiresAt` | The start and the end, in ms since 1970. |
| `copied`, `skipped` | The number of cookies copied, and the cookies not copied, each with a reason. |

### Errors

`FoxlendError` has a `code`: `bad-domain`, `bad-allow`, `bad-ttl`, `bad-url`,
`bad-scope`, `setting-failed`, `no-host-access`, `lend-failed`, `revoke-failed`, or
`storage-error`. A failed
lend undoes its steps. A failed revoke keeps blocking the container, and the
next start tries again.

### Other exports

| Export | What it does |
|---|---|
| `withDefaultRule(publicSuffix)` | Adds the default rule of the public suffix list. Firefox returns `null` for hosts on top-level domains that are not on the list, such as `.test` and `.localhost`. |
| `siteOf(host, publicSuffix)` | The registrable domain of a host. |
| `loanPatterns(input)` | The host patterns of a loan. |
| `planCopy(cookies, options)` | The `cookies.set` calls that copy one site's cookies. |
| `judge(request, loans, now, publicSuffix)` | The guard decision for one request. |
| `DEAD_PROXY`, `CONTAINER` | The proxy that blocked requests go to, and the container name prefix, color, and icon. |

### Firefox APIs used

| API | MDN | Why |
|---|---|---|
| `contextualIdentities.create`, `get`, `query`, `remove` | [contextualIdentities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities) | Make one container for each loan, and remove it. |
| `cookies.getAll`, `set`, `remove` with `storeId`, `partitionKey`, `firstPartyDomain` | [cookies](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies) | Read your cookies, copy one site's cookies into the loan container, and keep partitioned cookies in their partition. |
| `webRequest.onBeforeRequest` (blocking, `details.cookieStoreId`) | [webRequest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/onBeforeRequest) | Cancel each request from a loan container to a host that is not on the list. Permissions `webRequest` and `webRequestBlocking`. |
| `proxy.onRequest` (`details.cookieStoreId`) | [proxy.onRequest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/onRequest) | The second layer. It also stops speculative connections. |
| `privacy.network.networkPredictionEnabled` | [privacy.network](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/network) | Turn off DNS prefetch and link prefetch while a loan is active. |
| `privacy.network.peerConnectionEnabled` | [privacy.network](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy/network) | Turn off WebRTC while a loan is active. Its UDP traffic passes neither guard layer. |
| `browsingData.remove` with `cookieStoreId` | [browsingData](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/browsingData/remove) | Clear the cookies, local storage, and IndexedDB of the container. |
| `tabs.create` with `cookieStoreId`, `tabs.query`, `tabs.remove` | [tabs.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create) | Open the task tab in the container, and close every tab of the loan. |
| `tabs.hide` | [tabs.hide](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/hide) | Hide the task tab. Permission `tabHide`. |
| `publicSuffix.getDomain`, `getKnownSuffix` | [publicSuffix](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/publicSuffix) | Find the site of a host with no bundled list (Firefox 153+). |
| `permissions.contains`, `permissions.onRemoved` | [permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions) | Refuse a loan without access to all sites, and revoke every loan when the user removes that access. |
| `alarms` | [alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms) | Revoke a loan at its end, also when the event page is not loaded. |
| `runtime.onStartup` | [runtime.onStartup](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onStartup) | Revoke loans whose time ended while Firefox was closed. |
| `storage.local` | [storage.local](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local) | Keep the loan records. |
| `storage.session`, `runtime.sendMessage`, `runtime.onMessage` | [runtime](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime) | The sidebar talks to the background page and reads the blocked log. Demo only. |
| `sidebarAction` (`sidebar_action`) | [sidebarAction](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction) | The demo sidebar. Demo only. |
| `tabs.captureTab` | [tabs.captureTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab) | The E2E test takes a screenshot of the loan tab. Test only. |

## Delivery and behavior limits

- A lent cookie still lets the agent act as you on that site. The allow list
  limits where data can go. It does not limit what the agent does on the
  lent site. The foxgate scope works only when your agent loop asks the gate
  before each action.
- Data can still leave through a host that is allowed, for example as a
  comment on the lent site or an upload to an allowed host.
- Sessions that are bound to the device may fail in the container: client
  certificates, sessions bound to an IP address or a TLS channel, and logins
  that need a passkey at each use.
- foxlend does not change the cookies in your default container. The site
  can still end your session on its side, for example when it rotates a
  session token that the agent uses.
- Android has no containers, so foxlend works on desktop Firefox only.
- foxlend does not detect DNS rebinding. The allow list trusts the DNS of
  the hosts on it.
- WebRTC and network prediction are off for all of Firefox while a loan is
  active, also in your own tabs. No page can start a WebRTC call, for
  example a video call, until the last loan ends. Without these settings off, WebRTC sends UDP
  packets that neither guard layer sees (seen in Firefox 157).
- The network prediction setting does not stop everything. A
  `<link rel="preconnect">` still happens with the setting off (seen in Firefox 157). The proxy layer stops
  it. The E2E test cannot see DNS lookups, so it does not prove that DNS
  prefetch stops.
- Firefox cannot clear service workers for one container. Service worker
  data of the loan container can stay on disk after a revoke. Firefox did not
  use the removed container ID again in our tests.
- The guard covers pages in the loan container. It does not cover your agent
  code, for example the calls from your extension to a model API.
- The start sweep removes every container whose name starts with
  `Agent · ` and that is purple with the fingerprint icon, when no loan holds
  it. Do not use that combination for your own containers.
- When a site uses only `Secure` cookies, copies need an `https:` URL. The
  E2E test uses `http:` sites on `.localhost`, so `Secure` cookies and
  first-party isolation are covered by the Node tests only.
- Extensions that move tabs between containers (for example Multi-Account
  Containers or Temporary Containers) can open a URL that foxlend blocked in
  another container, outside the loan. Do not use them with foxlend.
- When foxlend cannot read its loan records (a storage error), the guard
  blocks requests from containers other than the default and private stores. This is on purpose: it fails closed.
- Run one lender, in the background page. Two lenders on the same storage,
  for example one in a sidebar and one in the background, can overwrite each
  other's records.
- The proxy layer was not tested together with another extension that sets
  a proxy.
- If the TTL ends while Firefox is closed, the revoke happens at the next
  start. The copied cookies have already expired by then. Cookies that the
  site set in the loan container during the loan (for example a new session
  token) are not capped, so they stay valid until that revoke. The same
  holds when a revoke fails or the extension is off.

## Integration guides

- [Firefox permission reference](#firefox-apis-used): browser APIs and required capabilities.
- [Loan configuration](#lend-options): scopes, TTL, exact-host matching, and allowed hosts.
- [Library API](#api): lifecycle methods, events, and errors.

## Status

Version 0.1.3 is an early release. APIs can change before 1.0.
Use [GitHub issues](https://github.com/pooriaarab/foxlend/issues) for support.
Public case studies are not yet published in this repository.
AMO installation is not a prerequisite for the library; load the bundled extension locally for development.

## FAQ

### What is foxlend?

foxlend lends eligible login cookies to a separate Firefox container for an agent task.
It adds request host controls and a matching foxgate grant.

### Which integrations are verified?

foxlend implements Firefox and foxgate integration paths with local tests.
This rewrite checks the source and local gate; it does not add a real-browser verification claim.

### Does foxlend provide a managed browser service?

foxlend runs inside your Firefox extension.
You supply the browser, agent loop, and any model service.

### How is foxlend different from Mozilla Multi-Account Containers?

foxlend exposes a timed cookie-loan API with host guards and foxgate grants.
Mozilla Multi-Account Containers provides separate browser identities through an add-on.

### How is foxlend different from Temporary Containers?

foxlend copies an existing site's cookies into a loan container and manages its grant.
Temporary Containers provides disposable browser containers.

### Does read scope make the website read-only?

foxlend assigns a foxgate scope, which your agent loop must check before each action.
Its network guard checks hosts rather than website actions or HTTP methods.

### Does revocation erase every trace of a session?

foxlend clears supported cookie, local storage, and IndexedDB data during cleanup.
Service worker data can remain, and a site can retain server-side session records.

### Can data leave through an allowed host?

foxlend allows network requests to hosts on the loan's list.
An upload or comment to an allowed host can still disclose data.

### Does foxlend affect my own browser tabs?

foxlend leaves default-container cookies untouched.
Its default network prediction and WebRTC settings apply across Firefox while loans remain active.

## Development

```bash
pnpm install --frozen-lockfile
pnpm ci:local
pnpm e2e
```

The local gate includes library tests, extension build, web-ext lint, and AMO listing checks.
Browser tests require Firefox. Set `FIREFOX` when binary lookup fails.
Build with `pnpm build:ext`, then load `dist-ext/manifest.json` for the sidebar demo.

## License

[MIT](https://opensource.org/license/mit)
