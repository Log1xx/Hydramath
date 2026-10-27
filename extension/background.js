// Service worker: talks to the Claude API and captures screenshots for the content script.
// Uses raw fetch because an MV3 extension without a bundler can't import the SDK.

const API_URL = "https://api.anthropic.com/v1/messages";

const DEFAULTS = {
  model: "claude-opus-5-5",
  effort: "medium",
};

// Models that support the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

const SYSTEM_PROMPT = `You solve math problems found on a web page and decide what to enter into the page's answer fields.

The page is given as text in reading order. Each paragraph starts with a tag like ¶12. Math appears between $...$ (LaTeX or linear text like (11)/(n(n+1))), sometimes followed by its exact read-aloud form; trust the read-aloud form if the two disagree. Answer fields appear as markers:
- [[INPUT id=N type=T]]: a text or number field (value="..." shows what is already typed)
- [[SELECT id=N options="a | b | c"]]: a dropdown
- [[CHOICE id=N kind=radio|checkbox]]: one option of a multiple-choice question; its label (which may contain math or its own answer fields) is the text right after the marker. "selected" means it is already chosen.
- [[MATHFIELD id=N]]: a math editor widget that is filled by typing on a keyboard
A field marked "disabled" usually becomes usable once the option it sits in is selected.
Parts of the page inside frames are marked "--- frame ---" and their ids and ¶ tags look like f123-7. Copy ids and tags exactly as written.

Multiple choice: give "true" for the option to pick (for kind=checkbox / "select all that apply", every correct option), and "false" only to unselect an already selected wrong option. When a question has both choices and blanks, such as "A. The series converges to [[MATHFIELD]]" or a choice followed by boxes, list the choice fill first and then every blank that belongs to the chosen option or to the question. Never fill blanks inside options you did not choose.

For each math problem on the page:
1. Solve it carefully. Check your arithmetic.
2. List the ¶ tags of the paragraphs that state it (instructions and the math, not the answer fields) in question_refs.
3. Work out which field(s) belong to it. Usually that is the field right after the question, or the fields that follow its sub-parts.
4. Give each field the value in the form it expects: plain typeable text such as "3/4", "2x+1", "-5", "x=3" for INPUT fields (only digits, ".", "-", "e" for type=number), exactly one listed option for SELECT, "true" for each CHOICE option to select (omit the ones to leave unselected), and for MATHFIELD the exact keys to type, never LaTeX: "3/4", "-12", "2x+5", "x^2" (the editor turns "/" into a fraction and "^" into an exponent). After an exponent or a fraction's denominator the cursor stays inside it, so type "→" (right arrow) to step out before continuing: "x^2→+3x", "1/2→+x". "/" takes only the term just before it as the numerator, so wrap a longer numerator or denominator in parentheses: "(1-r)/(1+r)", "(x+1)/(2x)". Type pi as "pi" (the editor turns it into π): "2pi", "(3pi)/4". Type a square root as "\sqrt", then what goes inside, then "→" to leave the root: "\sqrt2→/2", "3\sqrtx+1→" (everything typed before "→" stays under the root). No other LaTeX. No spaces. Follow any instructions on the page about format, rounding, or units.

Ignore fields that are not answer fields (search boxes, login, comments). If a question has no field, still solve it and leave fills empty. If a screenshot is attached, use it for math that is drawn as an image.`;

// Added when the page is a Pearson MyLab question (the content script detected its player).
const MYLAB_NOTES = `

This page is a Pearson MyLab question; only its question panel is included. MyLab specifics:
- The panel has a top pane (the problem) and a bottom pane (what to answer), grouped by "Part 1", "Part 2" headings. Answer every part that still has an empty box or no selected choice; leave parts that are already answered.
- [[CHOICES id=M1 pick=one|many]] is a whole multiple-choice question, with its options on the following lines as "A) …", "B) …". Fill it once, with just the letter of the correct option, e.g. "A"; for pick=many give every correct letter, e.g. "A, C". Check each option against the problem before choosing: options often differ only by a sign, a missing "+", or one term.
- Answer boxes keep MyLab's ids (e.g. S1, or f12-S1 inside a frame). The hint shows the text in front of the box, such as "S_n =" or "The sum is"; type only what goes after it.
- If an option contains its own answer box, fill the CHOICES letter first and then that box. Fill only boxes inside the option you chose.
- Math and options come with MyLab's read-aloud text. Use it to settle what applies to what: "cosine StartFraction 6 Over n EndFraction" is cos(6/n), and "limit as n approaches infinity" scopes over everything after it.
- MyLab grades exact answers: give simplified fractions, not decimals, unless the question asks you to round (then round exactly as told). Use integers or simplified fractions for exact values.`;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    problems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The problem, briefly restated" },
          question_refs: {
            type: "array",
            items: { type: "string" },
            description: "Numbers of the ¶ paragraphs that state the problem, e.g. [\"3\", \"4\"]",
          },
          answer: { type: "string", description: "The final answer, human readable" },
          steps: { type: "string", description: "A short worked solution" },
          fills: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Field id from the marker" },
                value: { type: "string" },
              },
              required: ["id", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["question", "question_refs", "answer", "steps", "fills"],
        additionalProperties: false,
      },
    },
  },
  required: ["problems"],
  additionalProperties: false,
};

// Every setting, including the API key, lives in chrome.storage.sync so it follows the
// user to any Chrome signed into the same account.
function getSettings() {
  return chrome.storage.sync.get({ ...DEFAULTS, apiKey: "" });
}

// Earlier versions kept these in local storage; move them over once.
const MOVED_TO_SYNC = ["apiKey", "hidden", "opacity"];
async function migrateToSync() {
  const local = await chrome.storage.local.get(MOVED_TO_SYNC);
  const keys = Object.keys(local);
  if (!keys.length) return;
  const sync = await chrome.storage.sync.get(keys);
  const patch = Object.fromEntries(keys.filter((k) => sync[k] === undefined).map((k) => [k, local[k]]));
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  await chrome.storage.local.remove(keys);
}
chrome.runtime.onInstalled.addListener(migrateToSync);
chrome.runtime.onStartup.addListener(migrateToSync);

async function solve({ snapshot, screenshot, url, title, mylab }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    const err = new Error("Add your Anthropic API key in the extension settings.");
    err.code = "NO_KEY";
    throw err;
  }

  const content = [];
  if (screenshot) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: screenshot.split(",")[1] },
    });
  }
  content.push({
    type: "text",
    text: `Page: ${title}\nURL: ${url}\n\n<page>\n${snapshot}\n</page>`,
  });

  const body = {
    model: settings.model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: settings.effort,
      format: { type: "json_schema", schema: RESULT_SCHEMA },
    },
    system: mylab ? SYSTEM_PROMPT + MYLAB_NOTES : SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  };

  const headers = {
    "content-type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };

  if (FALLBACK_MODELS.has(settings.model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }

  const res = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("The API key was rejected. Check it in settings.");
    if (res.status === 429) throw new Error("Rate limited by the API. Wait a moment and try again.");
    throw new Error(`API error: ${msg}`);
  }

  if (data.stop_reason === "refusal") {
    throw new Error("The model declined to answer this page.");
  }
  if (data.stop_reason === "max_tokens") {
    throw new Error("The answer was cut off. Try picking a smaller part of the page.");
  }

  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return { ...JSON.parse(text), model: data.model };
  } catch {
    throw new Error("Couldn't read the model's answer.");
  }
}

// Real keystrokes through the DevTools protocol. Some math editors ignore script-made
// key events (isTrusted = false); these are indistinguishable from the user typing.
// Chrome shows a "started debugging this browser" bar while attached.
const SHIFTED = { "^": ["6", 54], "+": ["=", 187], "(": ["9", 57], ")": ["0", 48], "*": ["8", 56], "!": ["1", 49], "%": ["5", 53], "|": ["\\", 220], "<": [",", 188], ">": [".", 190], "_": ["-", 189], "{": ["[", 219], "}": ["]", 221] };
const PLAIN = { "/": 191, "-": 189, "=": 187, ".": 190, ",": 188, " ": 32, "[": 219, "]": 221, "\\": 220 };

function keyEventsFor(ch) {
  if (ch === "→") {
    const k = { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 };
    return [{ type: "rawKeyDown", ...k }, { type: "keyUp", ...k }];
  }
  let vk, modifiers = 0;
  if (/[a-z]/i.test(ch)) {
    vk = ch.toUpperCase().charCodeAt(0);
    if (ch !== ch.toLowerCase()) modifiers = 8;
  } else if (/\d/.test(ch)) vk = ch.charCodeAt(0);
  else if (SHIFTED[ch]) [vk, modifiers] = [SHIFTED[ch][1], 8];
  else vk = PLAIN[ch] ?? 0;
  const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  return [{ type: "keyDown", text: ch, unmodifiedText: ch, ...base }, { type: "keyUp", ...base }];
}

async function trustedType(tabId, text) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    for (const ch of text) {
      for (const ev of keyEventsFor(ch)) await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", ev);
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Questions often live in iframes (sometimes from another domain), so every frame runs the
// content script. Ask each one for its part of the page; ids are prefixed "f<frameId>-".
async function collectFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const parts = await Promise.all(
    frames.map(async ({ frameId }) => {
      try {
        const prefix = frameId ? `f${frameId}-` : "";
        const res = await chrome.tabs.sendMessage(tabId, { type: "ma-call", call: "snapshot", args: [prefix] }, { frameId });
        return res?.ok && res.result?.text ? { frameId, ...res.result } : null;
      } catch {
        return null; // frame without the content script (e.g. chrome:// or loaded before install)
      }
    })
  );
  return parts.filter(Boolean).sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0));
}

function callFrames(tabId, frameIds, call, args) {
  return Promise.all(
    frameIds.map((frameId) =>
      chrome.tabs
        .sendMessage(tabId, { type: "ma-call", call, args }, { frameId })
        .catch((e) => ({ ok: false, error: e.message }))
    )
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "collect") {
    collectFrames(sender.tab.id)
      .then((parts) => sendResponse({ ok: true, parts }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "frames-call") {
    callFrames(sender.tab.id, msg.frameIds, msg.call, msg.args).then(sendResponse);
    return true;
  }
  if (msg.type === "hotkey") {
    // A shortcut pressed while focus was inside an iframe; the top frame acts on it.
    chrome.tabs.sendMessage(sender.tab.id, { type: "ma-hotkey", action: msg.action }, { frameId: 0 }).catch(() => {});
  }
  if (msg.type === "open-shortcuts") {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  }
  if (msg.type === "trusted-type") {
    trustedType(sender.tab.id, msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "solve") {
    solve(msg)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
    return true;
  }
  if (msg.type === "capture") {
    chrome.tabs
      .captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 70 })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
});

// Toolbar button and Alt+M both toggle the panel. Inject the content script first
// on tabs that were open before the extension was installed.
// The extension only works on Pearson MyLab (the content script checks this too).
const MYLAB_HOST = "mylab.pearson.com";
const isMylab = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === MYLAB_HOST;
  } catch {
    return false;
  }
};

// Grey out the toolbar icon everywhere except MyLab.
function setupActionRules() {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: MYLAB_HOST, schemes: ["https"] } })],
        actions: [new chrome.declarativeContent.ShowAction()],
      },
    ]);
  });
}
chrome.runtime.onInstalled.addListener(setupActionRules);

async function togglePanel(tab) {
  if (!tab?.id || !isMylab(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["keys.js", "content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" });
    } catch {
      // chrome:// pages, the Web Store, etc. can't be scripted.
    }
  }
}

chrome.action.onClicked.addListener(togglePanel);
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  togglePanel(tab);
});
