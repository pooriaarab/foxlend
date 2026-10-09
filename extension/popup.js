// The demo popup. Replace this with a small view that shows foxlend working.
browser.storage.local.get("fixture").then(({ fixture }) => {
  document.getElementById("value").textContent = fixture ?? "missing";
});
