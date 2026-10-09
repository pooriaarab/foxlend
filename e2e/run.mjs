// The E2E test: the full foxlend pitch in a real Firefox. It installs the
// demo extension (dist-ext/), serves the local sites in e2e/sites.mjs, and
// writes artifacts/e2e-<date>.json. It checks X1-X8 in docs/failure-modes.md.
// Usage: pnpm e2e [--headed] [--screenshots <dir>]. Env: FIREFOX (the Firefox binary).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, poll, serve } from "create-foxkit/e2e";
import { startSites } from "./sites.mjs";

const shotsAt = process.argv.indexOf("--screenshots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : undefined;
const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual: structuredClone(actual), ok: JSON.stringify(actual) === JSON.stringify(expected) });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (what, fn, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (fn()) return;
  throw new Error(`Timed out waiting for ${what}.`);
};
const heading = (page) => page.evaluate(() => document.querySelector("h1")?.textContent);
const paths = (list, layer) => [...new Set(list.filter((b) => b.host === "attacker.test" && b.layer === layer).map((b) => new URL(b.url).pathname))].toSorted();
const byName = (a, b) => `${a.name}${a.domain}`.localeCompare(`${b.name}${b.domain}`);

const sites = await startSites();
const { ports, log } = sites;
const BANK = `http://www.bank.localhost:${ports.bank}`;
const ATTACKER = `http://attacker.test:${ports.attacker}`;
let fox;
try {
  fox = await launch({
    extension: "dist-ext",
    headless: !process.argv.includes("--headed"),
    prefs: {
      "network.dns.localDomains": "www.bank.localhost,evilbank.localhost,widget.test,news.test,attacker.test,leak.attacker.test",
      // Puppeteer turns speculative connections off. Turn them on, as in a normal profile.
      "network.http.speculative-parallel-limit": 6,
      "network.dns.disablePrefetch": false,
      "network.prefetch-next": true,
      "network.predictor.enabled": true,
      // The STUN server is on 127.0.0.1. Firefox skips loopback for WebRTC by default; a real
      // attacker uses a remote STUN server, which needs no pref. Allow loopback so the test sees it.
      "media.peerconnection.ice.loopback": true,
    },
  });
  record.firefox = await fox.browser.version();
  const ext = await fox.openExtensionPage("sidebar.html");
  const send = async (message) => {
    const answer = await ext.evaluate((m) => browser.runtime.sendMessage(m), message);
    if (answer?.error) throw new Error(`${message.type}: ${answer.error}: ${answer.message}`);
    return answer.result;
  };
  const userCookies = async () => (await ext.evaluate(() => browser.cookies.getAll({ storeId: "firefox-default", partitionKey: {} }))).toSorted(byName);
  const shot = async (page, file) => shots && (await page.screenshot({ path: join(shots, file) }));

  // X1: you log in, in your default container, and visit three other sites.
  const user = await fox.open(`${BANK}/login?user=sam`);
  await user.goto(`${BANK}/`);
  check("X1: your own tab is signed in", "Signed in as sam", await heading(user));
  const other = await fox.open(`${BANK}/widget-page`);
  await sleep(500);
  await other.goto(`http://news.test:${ports.others}/`);
  await sleep(500);
  await other.goto(`http://evilbank.localhost:${ports.bank}/`);
  await other.close();
  // X9: the WebRTC probe sees a positive case first, in your own tab.
  await user.goto(`${BANK}/webrtc`);
  await until("STUN packets from your own tab", () => log.udpPackets > 0);
  check("X9: before the loan, WebRTC in your own tab reaches the UDP listener", true, log.udpPackets > 0);
  await user.goto(`${BANK}/`);
  await sleep(1000);
  const packetsBefore = log.udpPackets;
  const before = await userCookies();
  check("X1: your cookies before the loan", ["evil", "framed", "session", "theme", "widget"], before.map((c) => c.name));
  await shot(user, "your-tab-before.png");

  // X2: lend the bank to the agent, with the sidebar form.
  await ext.evaluate((values) => {
    for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
    document.getElementById("lend-button").click();
  }, { domain: "www.bank.localhost", url: `${BANK}/inbox`, scope: "read", ttl: "900000", allow: "widget.test" });
  await poll(ext, () => document.querySelectorAll("#loans li").length === 1);
  const [loan] = await send({ type: "loans" });
  check("X2: the sidebar lists the loan", "Agent · bank.localhost", await ext.evaluate(() => document.querySelector("#loans li .name").textContent));
  const containers = await ext.evaluate(() => browser.contextualIdentities.query({}));
  check("X2: the loan container exists", { name: "Agent · bank.localhost", color: "purple", icon: "fingerprint" }, (({ name, color, icon }) => ({ name, color, icon }))(containers.find((c) => c.cookieStoreId === loan.cookieStoreId) ?? {}));
  // Puppeteer does not see tabs in a container made after it started, so
  // the test reads the bank server log, and the extension takes screenshots.
  const shotTab = async (tabId, file) => {
    if (!shots) return;
    const url = await ext.evaluate((id) => browser.tabs.captureTab(id), tabId);
    writeFileSync(join(shots, file), Buffer.from(url.split(",")[1], "base64"));
  };
  // BiDi cannot take a screenshot of a moz-extension: page. Serve the same
  // sidebar over http with a stub browser object and the real loan data.
  const shotSidebar = async (demo) => {
    const dir = mkdtempSync(join(tmpdir(), "foxlend-preview-"));
    cpSync("dist-ext", dir, { recursive: true });
    cpSync("e2e/stub.js", join(dir, "stub.js"));
    const data = `<script>window.foxlendDemo = ${JSON.stringify(demo).replaceAll("<", "\\u003c")};</script><script src="stub.js"></script>`;
    writeFileSync(join(dir, "preview.html"), readFileSync(join(dir, "sidebar.html"), "utf8").replace('<script src="sidebar.js">', `${data}<script src="sidebar.js">`));
    const preview = await serve(dir);
    const page = await fox.open(`${preview.url}/preview.html`);
    await page.setViewport({ width: 380, height: 1000 });
    await poll(page, () => document.body.dataset.ready === "1");
    await page.screenshot({ path: join(shots, "sidebar.png") });
    await page.close();
    await preview.close();
    rmSync(dir, { recursive: true, force: true });
  };
  await until("the loan tab", () => log.bank.some((r) => r.path === "/inbox"));
  check("X2: the loan tab is signed in", "sam", log.bank.find((r) => r.path === "/inbox").user);

  // X3, X4: what the loan container holds.
  const lent = (await ext.evaluate((id) => browser.cookies.getAll({ storeId: id, partitionKey: {} }), loan.cookieStoreId)).toSorted(byName);
  check("X3, X4: only the bank's cookies and its widget cookie are copied", ["session", "theme", "widget"], lent.map((c) => c.name));
  const session = lent.find((c) => c.name === "session");
  const userSession = before.find((c) => c.name === "session");
  check("X3: the session keeps HttpOnly, SameSite, and host-only", { httpOnly: true, sameSite: "lax", hostOnly: true, value: userSession.value }, { httpOnly: session.httpOnly, sameSite: session.sameSite, hostOnly: session.hostOnly, value: session.value });
  check("X3: every copy expires by the loan end", true, lent.every((c) => c.expirationDate <= loan.expiresAt / 1000));
  check("X4: the widget cookie stays in the bank partition", "http://bank.localhost", lent.find((c) => c.name === "widget")?.partitionKey?.topLevelSite);

  // X5: the hidden prompt injection tries to send the account number to attacker.test.
  await until("the page report", () => log.reports.length === 1);
  await sleep(500);
  const blocked = await send({ type: "blocked" });
  check("X5: webRequest blocks every way out", ["/beacon", "/fetch", "/frame", "/from-sw", "/img", "/via-redirect", "/ws"], paths(blocked, "webRequest"));
  check("X5: the request types blocked", ["beacon", "image", "sub_frame", "websocket", "xmlhttprequest"], [...new Set(blocked.filter((b) => b.layer === "webRequest").map((b) => b.type))].toSorted());
  check("X5: the proxy layer stops the preconnect, which webRequest cannot see", ["speculative"], blocked.filter((b) => b.layer === "proxy").map((b) => b.type));
  check("X5: each block names the loan and the reason", true, blocked.every((b) => b.loanId === loan.id && b.reason === "not-allowed"));
  check("X5: a block names the page that sent it", `${BANK}/inbox`, blocked.find((b) => b.url.includes("/fetch"))?.initiator);
  check("X5: the attacker got no request", [], log.attacker);
  check("X5: the attacker got no connection", 0, log.attackerConnections);
  check("X9: while the loan is active, the loan page's WebRTC try sends no packet", [true, packetsBefore], [log.reports[0].includes("webrtc: blocked"), log.udpPackets]);
  check("X5: the page saw its tries fail", true, log.reports[0].some((t) => t === "fetch: blocked") && log.reports[0].some((t) => t === "image: blocked"));
  await shotTab(loan.tabId, "loan-tab-blocked.png");

  // X5: with network prediction off, Firefox sends no link prefetch. Give
  // the setting back, load the page again, and see the prefetch blocked too.
  check("X5: with prediction off, Firefox sends no link prefetch", false, blocked.some((b) => b.url.includes("/prefetch")));
  await ext.evaluate(() => browser.privacy.network.networkPredictionEnabled.clear({}));
  await ext.evaluate((id) => browser.tabs.reload(id), loan.tabId);
  await until("the second page report", () => log.reports.length === 2);
  await sleep(500);
  check("X5: with prediction on, the link prefetch is blocked", true, (await send({ type: "blocked" })).some((b) => b.url.includes("/prefetch") && b.layer === "webRequest"));
  check("X5: the attacker still got no request and no connection", [[], 0], [log.attacker, log.attackerConnections]);

  // The foxgate grant covers the lent site only.
  const verdict = async (domain) => {
    const d = await send({ type: "check", tool: "read_page", domain, scope: "read" });
    return d.decision === "deny" ? `deny: ${d.reason}` : d.decision;
  };
  check("the foxgate grant allows the lent site", "allow", await verdict("www.bank.localhost"));
  check("the foxgate grant does not allow attacker.test", "deny: no-grant", await verdict("attacker.test"));

  // X6: your own tab is not under the guard.
  await user.goto(`${ATTACKER}/from-your-tab`);
  check("X6: your own tab can reach attacker.test", true, log.attacker.some((r) => r.path === "/from-your-tab"));

  // X7: take the login back.
  check("X5: the sidebar log shows the blocked requests", true, await ext.evaluate(() => document.querySelectorAll("#blocked li").length >= 8));
  if (shots) await shotSidebar({ loans: await send({ type: "loans" }), blocked: await send({ type: "blocked" }), tab: { url: `${BANK}/` } });
  await ext.evaluate(() => document.querySelector("#loans li .revoke").click());
  await poll(ext, () => document.querySelectorAll("#loans li").length === 0 && !document.getElementById("no-loans").hidden);
  check("X7: the sidebar shows no loan after Revoke", "No active loans.", await ext.evaluate(() => document.getElementById("no-loans").textContent));
  const left = await ext.evaluate(() => browser.contextualIdentities.query({}));
  check("X7: the loan container is gone", false, left.some((c) => c.cookieStoreId === loan.cookieStoreId));
  check("X7: the loan tab is closed", [], await ext.evaluate((id) => browser.tabs.query({ cookieStoreId: id }).then((t) => t.map((x) => x.id)), loan.cookieStoreId));
  check("X7: Firefox shows no cookies in the loan store", 0, await ext.evaluate((id) => browser.cookies.getAll({ storeId: id, partitionKey: {} }).then((c) => c.length), loan.cookieStoreId));
  check("X7: no loan is left", [], await send({ type: "loans" }));
  check("X7: the grant is gone", "deny: no-grant", await verdict("www.bank.localhost"));
  await user.goto(`${BANK}/`);
  check("X7: your own tab is still signed in", "Signed in as sam", await heading(user));
  check("X7: your cookies did not change, values and flags included", true, JSON.stringify(before) === JSON.stringify(await userCookies()));
  await shot(user, "your-tab-after.png");
  await user.goto(`${BANK}/webrtc`);
  await until("STUN packets after the revoke", () => log.udpPackets > packetsBefore);
  check("X9: after the revoke, WebRTC works again in your own tab", true, log.udpPackets > packetsBefore);

  // X8: a short loan ends by itself at its alarm, with a hidden tab.
  const short = await send({ type: "lend", options: { domain: "www.bank.localhost", scope: "read", ttlMs: 3000, url: `${BANK}/`, hidden: true } });
  check("X8: the short loan tab is hidden", true, await ext.evaluate((id) => browser.tabs.get(id).then((t) => t.hidden), short.tabId));
  await sleep(6000);
  check("X8: the alarm revoked the short loan", [], await send({ type: "loans" }));
  check("X8: its container is gone", false, (await ext.evaluate(() => browser.contextualIdentities.query({}))).some((c) => c.cookieStoreId === short.cookieStoreId));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await sites.close();
}
record.passed = !record.error && record.checks.length >= 30 && record.checks.every((c) => c.ok);
// One check per line, so the diff of two runs shows each check that changed.
const { checks, ...head } = record;
const path = `artifacts/e2e-${new Date().toISOString().slice(0, 10)}.json`;
mkdirSync("artifacts", { recursive: true });
writeFileSync(path, `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "checks": [\n${checks.map((c) => `    ${JSON.stringify(c)}`).join(",\n")}\n  ]\n}\n`);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"} (${record.checks.length} checks)${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
