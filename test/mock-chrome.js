// Stand-in for the extension APIs so content.js runs as a plain page script.
// The top page defines window.__mockSolve(snapshot) -> problems. Iframes (same-origin here)
// reuse the top's mock and act as separate frames with frameId = their index + 1.
(() => {
  // The content script only runs on mylab.pearson.com; these local test pages opt in.
  window.__maTestAllowOrigin = true;
  if (window !== window.top) {
    window.chrome = window.top.chrome;
    return;
  }
  const store = { sync: {}, local: {} };
  const frameWindows = () => [window, ...[...document.querySelectorAll("iframe")].map((f) => f.contentWindow)];
  const listeners = [];
  const storageListeners = [];

  // Like chrome.storage: every frame's onChanged listeners hear every write.
  const area = (name) => ({
    get: async (d) => ({ ...d, ...structuredClone(store[name]) }),
    set: async (p) => {
      const changes = {};
      for (const [k, v] of Object.entries(p)) changes[k] = { oldValue: store[name][k], newValue: v };
      Object.assign(store[name], structuredClone(p));
      storageListeners.forEach((fn) => fn(changes, name));
    },
  });

  window.chrome = {
    storage: {
      sync: area("sync"),
      local: area("local"),
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    runtime: {
      // Extension pages resolve to their test harnesses next to this file.
      getURL: (p) => new URL(p, new URL("./", document.currentScript?.src || location.href)).href,
      // Only the top frame's listener matters (badge clicks from frames).
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        const wins = frameWindows();
        switch (msg.type) {
          case "collect": {
            const parts = wins
              .map((w, i) => (w.__maApi?.ready() ? { frameId: i, ...w.__maApi.snapshot(i ? `f${i}-` : "") } : null))
              .filter((p) => p?.text);
            return { ok: true, parts };
          }
          case "frames-call":
            return Promise.all(msg.frameIds.map(async (fid) => ({ ok: true, result: await wins[fid].__maApi[msg.call](...msg.args) })));
          case "badge-click":
            listeners[0]?.({ type: "ma-badge-click", n: msg.n }, {}, () => {});
            return;
          case "hotkey":
            listeners[0]?.({ type: "ma-hotkey", action: msg.action }, {}, () => {});
            return;
          case "trusted-type":
            (window.__trustedCalls ||= []).push(msg.text);
            return window.__mockTrusted ? window.__mockTrusted(msg.text) : { ok: false, error: "no debugger in test" };
          case "solve":
            window.__lastSnapshot = msg.snapshot;
            await new Promise((r) => setTimeout(r, 800));
            return { ok: true, result: { model: "mock-model", problems: window.__mockSolve(msg.snapshot) } };
        }
        return { ok: false };
      },
    },
  };
})();
