// Settings page, shown full-page (Extension options) or inside the panel (?embedded).
// Everything saves as you change it, to chrome.storage.sync.

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  autoFill: true,
  includeScreenshot: false,
  matchPage: true,
  showHighlights: true,
  showButton: true,
  hidden: false,
  opacity: 1,
  keybinds: {},
};
const TOGGLES = ["autoFill", "includeScreenshot", "matchPage", "showHighlights", "showButton", "hidden"];

const $ = (id) => document.getElementById(id);
const save = (patch) => chrome.storage.sync.set(patch);

// Sync storage allows about 2 writes a second; batch rapid changes (typing, dragging the slider).
function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Solver ----------

const saveKey = debounce(async (value) => {
  await save({ apiKey: value });
  $("keyStatus").textContent = value ? "Saved ✓" : "";
}, 500);

$("apiKey").addEventListener("input", () => {
  $("keyStatus").textContent = "";
  saveKey($("apiKey").value.trim());
});

$("reveal").addEventListener("click", () => {
  const input = $("apiKey");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("reveal").textContent = show ? "Hide" : "Show";
});

for (const id of ["model", "effort"]) $(id).addEventListener("change", () => save({ [id]: $(id).value }));

// ---------- Behaviour / visibility ----------

for (const id of TOGGLES) $(id).addEventListener("change", () => save({ [id]: $(id).checked }));

function showOpacity(pct) {
  $("opacity").value = pct;
  $("opacityOut").textContent = pct + "%";
}
const saveOpacity = debounce((v) => save({ opacity: v }), 250);
$("opacity").addEventListener("input", () => {
  const pct = +$("opacity").value;
  showOpacity(pct);
  saveOpacity(pct / 100);
});

$("chromeShortcuts").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-shortcuts" }));

// ---------- Keyboard shortcuts ----------

const { ACTIONS, DEFAULTS: DEFAULT_KEYS, comboOf, isUsable } = globalThis.MA_KEYS;
let keybinds = { ...DEFAULT_KEYS };
let recording = null; // action being recorded

function keyMsg(text, warn = false) {
  $("keyMsg").textContent = text;
  $("keyMsg").classList.toggle("warn", warn);
}

function renderKeys() {
  const rows = $("keyRows");
  rows.replaceChildren();
  for (const [action, label] of Object.entries(ACTIONS)) {
    const line = document.createElement("div");
    line.className = "line";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "key-btn";
    if (recording === action) {
      btn.textContent = "Press keys…";
      btn.classList.add("recording");
    } else if (keybinds[action]) {
      btn.textContent = keybinds[action];
    } else {
      btn.textContent = "Not set";
      btn.classList.add("empty");
    }
    btn.addEventListener("click", () => {
      recording = recording === action ? null : action;
      renderKeys();
    });
    line.append(label, btn);
    rows.append(line);
  }
}

function saveKeys(patch) {
  keybinds = { ...keybinds, ...patch };
  return save({ keybinds });
}

addEventListener("keydown", async (e) => {
  if (!recording) return;
  e.preventDefault();
  const action = recording;
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
  if (e.key === "Escape" && plain) {
    recording = null;
    renderKeys();
    return;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && plain) {
    recording = null;
    await saveKeys({ [action]: "" });
    keyMsg(`${ACTIONS[action]} cleared.`);
    renderKeys();
    return;
  }
  const combo = comboOf(e);
  if (!combo) return; // still holding modifiers
  if (!isUsable(combo)) {
    keyMsg("Include Ctrl or Alt so it doesn't fire while you type answers.", true);
    return;
  }
  // One combo per action: take it away from whichever action had it.
  const taken = Object.keys(keybinds).find((a) => a !== action && keybinds[a] === combo);
  recording = null;
  await saveKeys({ [action]: combo, ...(taken && { [taken]: "" }) });
  keyMsg(taken ? `${combo} moved from ${ACTIONS[taken]} to ${ACTIONS[action]}.` : `${ACTIONS[action]}: ${combo}`);
  renderKeys();
}, true);

// ---------- Loading and staying in sync ----------

function render(s) {
  if (document.activeElement !== $("apiKey")) $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("effort").value = s.effort;
  for (const id of TOGGLES) $(id).checked = !!s[id];
  showOpacity(Math.round(s.opacity * 100));
  keybinds = { ...DEFAULT_KEYS, ...s.keybinds };
  renderKeys();
}

// Changes from a page shortcut, the panel, or another synced browser show up live.
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area === "sync") render(await chrome.storage.sync.get(DEFAULTS));
});

chrome.storage.sync.get(DEFAULTS).then(render);

// ---------- Theme from the panel ----------

// The panel posts its current colours so the embedded page matches it (page-matched or not).
// Only plain colour values are accepted.
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i;
addEventListener("message", (e) => {
  if (e.source !== parent || e.data?.type !== "ma-theme") return;
  for (const [k, v] of Object.entries(e.data.vars || {})) {
    if (/^--[\w-]+$/.test(k) && COLOR.test(v)) document.documentElement.style.setProperty(k, v);
  }
});
// Ask the panel for its colours now that we're listening (it may have sent them before).
if (parent !== window) parent.postMessage({ type: "ma-settings-ready" }, "*");
