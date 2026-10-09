// The sidebar: lend the current site, list the active loans with Revoke,
// and show the requests that the guard blocked. The background runs foxlend.
const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text });
const ask = (message) => browser.runtime.sendMessage(message);
let loans = [];

const left = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
};

function renderLoans() {
  $("no-loans").hidden = loans.length > 0;
  $("loans").replaceChildren(
    ...loans.map((loan) => {
      const li = el("li");
      li.dataset.id = loan.id;
      const revoke = el("button", "revoke", "Revoke");
      revoke.addEventListener("click", () => ask({ type: "revoke", id: loan.id }).then(refresh));
      li.append(
        el("div", "name", loan.containerName),
        el("div", "meta", `${loan.scope} · ${left(loan.expiresAt - Date.now())} · ${loan.copied} cookies copied${loan.hidden ? " · tab hidden" : ""}`),
        el("div", "meta", `Allowed: ${loan.patterns.join(", ")}`),
        revoke,
      );
      return li;
    }),
  );
}

async function refresh() {
  loans = (await ask({ type: "loans" })).result ?? [];
  renderLoans();
  const blocked = (await ask({ type: "blocked" })).result ?? [];
  $("no-blocked").hidden = blocked.length > 0;
  $("blocked").replaceChildren(
    ...blocked.map((b) => {
      const li = el("li");
      li.append(
        el("div", "what", `${new Date(b.at).toLocaleTimeString()} ${b.type} to ${b.host ?? "?"} (${b.layer})`),
        el("div", "url", b.url),
        el("div", "from", b.initiator ? `from ${b.initiator}` : ""),
      );
      return li;
    }),
  );
  document.body.dataset.ready = "1";
}

// Fill the form from the active tab.
browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.url?.startsWith("http")) return;
  const url = new URL(tab.url);
  $("domain").value = url.hostname;
  $("url").value = url.href;
});

$("lend-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const allow = $("allow").value.split(",").map((s) => s.trim()).filter(Boolean);
  const options = { domain: $("domain").value.trim(), scope: $("scope").value, ttlMs: Number($("ttl").value), allow, hidden: $("hidden").checked };
  if ($("url").value.trim()) options.url = $("url").value.trim();
  const answer = await ask({ type: "lend", options });
  $("lend-result").textContent = answer.error ? `${answer.error}: ${answer.message}` : "";
  await refresh();
});

browser.runtime.onMessage.addListener((message) => void (message?.type === "changed" && refresh()));
setInterval(renderLoans, 1000);
refresh();
