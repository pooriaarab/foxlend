// A stub browser object, so the sidebar runs on a plain http page where
// WebDriver BiDi can take a screenshot. It answers with data that the real
// E2E run read from the real extension (window.foxlendDemo).
(() => {
  const demo = window.foxlendDemo;
  const answers = { loans: demo.loans, blocked: demo.blocked };
  window.browser = {
    runtime: {
      sendMessage: async (message) => ({ result: answers[message.type] ?? null }),
      onMessage: { addListener: () => undefined },
    },
    tabs: { query: async () => [demo.tab] },
  };
})();
