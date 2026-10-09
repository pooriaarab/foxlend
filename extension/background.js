// The demo background (an MV3 event page). It runs foxlend and foxgate with
// the real Firefox APIs. createFoxlend() runs at the top level, so Firefox
// can wake this page for a request from a loan container, an alarm, or a
// browser start. The popup and the sidebar talk to it with messages.
import { createFoxgate, storageAreaStore } from "foxgate";
import { createFoxlend, withDefaultRule } from "../src/index.ts";

const publicSuffix = withDefaultRule(browser.publicSuffix);
const { gate, host } = createFoxgate({
  tools: { read_page: "read", fill_form: "fill", submit_form: "submit" },
  store: storageAreaStore(browser.storage.local),
  publicSuffix,
});
const lender = createFoxlend({ browser, host, publicSuffix });

// The last 50 blocked requests. storage.session keeps them when the page unloads.
const tell = () => browser.runtime.sendMessage({ type: "changed" }).catch(() => undefined);
let saving = Promise.resolve();
lender.onBlocked.addListener((event) => {
  saving = saving.then(async () => {
    const { blocked = [] } = await browser.storage.session.get("blocked");
    await browser.storage.session.set({ blocked: [event, ...blocked].slice(0, 50) });
    tell();
  }).catch(() => undefined); // One failed write must not stop the log.
});
lender.onRevoked.addListener(tell);

const errorOf = (error) => ({ error: error.code ?? "error", message: error.message });
const handlers = {
  lend: (m) => lender.lend(m.options),
  revoke: (m) => lender.revoke(m.id),
  loans: () => lender.listLoans(),
  blocked: async () => (await saving, (await browser.storage.session.get("blocked")).blocked ?? []),
  // What the agent's gate says about one action, for example on a host outside the loan.
  check: (m) => gate.check({ tool: m.tool, args: {}, domain: m.domain, scope: m.scope }),
};
browser.runtime.onMessage.addListener((message) => {
  const handler = handlers[message?.type];
  if (!handler) return undefined;
  return Promise.resolve()
    .then(() => handler(message))
    .then((result) => {
      if (message.type === "lend" || message.type === "revoke") tell();
      return { result };
    }, errorOf);
});
