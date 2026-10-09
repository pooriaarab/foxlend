// The popup lists the active loans.
async function render() {
  const { result: loans = [] } = await browser.runtime.sendMessage({ type: "loans" });
  document.getElementById("count").textContent = String(loans.length);
  document.getElementById("loans").replaceChildren(
    ...loans.map((loan) => Object.assign(document.createElement("li"), { textContent: `${loan.containerName} (${loan.scope})` })),
  );
}
browser.runtime.onMessage.addListener((message) => void (message?.type === "changed" && render()));
render();
