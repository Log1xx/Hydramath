// Content script, runs in every frame. Each frame reads its own math and answer fields,
// fills them, and draws its own highlights. The top frame also hosts the floating button
// and panel, and coordinates the frames through the background worker.

(() => {
  // Only runs in tabs showing Pearson MyLab. The check is on the tab's top page, because MyLab
  // can load the question in a frame from another Pearson domain; those frames still run.
  const ALLOWED_TOP = "https://mylab.pearson.com";
  const ancestors = location.ancestorOrigins;
  const topOrigin = ancestors?.length ? ancestors[ancestors.length - 1] : location.origin;
  // __maTestAllowOrigin is set by the local test pages. A real page can't set it: content
  // scripts run in their own JavaScript world.
  if (topOrigin !== ALLOWED_TOP && !globalThis.__maTestAllowOrigin) return;

  if (window.__mathAutopilot) return;
  window.__mathAutopilot = true;

  const IS_TOP = window === window.top;
  const MAX_SNAPSHOT = 60000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let fields = new Map(); // id -> { el, kind }
  let blocks = new Map(); // paragraph id -> element
  let foundMath = []; // math elements seen in the last scan
  let host = null; // the panel's root element (top frame only)

  // ---------- Reading the page ----------

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "SVG", "CANVAS", "VIDEO", "AUDIO",
    "IFRAME", "FRAME", // each frame reports itself
  ]);
  const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "UL", "OL", "TR", "TABLE", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "FORM",
    "FIELDSET", "H1", "H2", "H3", "H4", "H5", "H6", "BR", "HR", "BLOCKQUOTE", "PRE", "DL", "DT", "DD", "LABEL",
  ]);
  const TEXT_INPUT_TYPES = new Set(["", "text", "number", "tel", "url"]);
  const CHOICE_ROLES = new Set(["radio", "checkbox", "option", "menuitemradio", "menuitemcheckbox"]);
  const CHOICE_CONTAINER = 'label, li, [role="radio"], [role="checkbox"], [role="option"], [role="menuitemradio"], [role="menuitemcheckbox"]';
  const ARIA_CHOICE = '[role="radio"], [role="checkbox"], [role="option"], [role="menuitemradio"], [role="menuitemcheckbox"]';

  function isVisible(el) {
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    return el.getClientRects().length > 0;
  }

  // Rough linear text for MathML: fractions, powers, roots, subscripts.
  function mathmlToText(node) {
    if (node.nodeType === 3) return node.nodeValue.trim();
    if (node.nodeType !== 1) return "";
    const tag = node.localName;
    const kids = [...node.children];
    const t = (n) => (n ? mathmlToText(n) : "");
    switch (tag) {
      case "annotation":
      case "annotation-xml":
        return "";
      case "mfrac":
        return `(${t(kids[0])})/(${t(kids[1])})`;
      case "msup":
        return `${t(kids[0])}^(${t(kids[1])})`;
      case "msub":
        return `${t(kids[0])}_(${t(kids[1])})`;
      case "msubsup":
        return `${t(kids[0])}_(${t(kids[1])})^(${t(kids[2])})`;
      case "msqrt":
        return `sqrt(${kids.map(t).join("")})`;
      case "mroot":
        return `root(${t(kids[1])}, ${t(kids[0])})`;
      default:
        return kids.length ? kids.map(t).join(" ") : node.textContent.trim();
    }
  }

  function texFromMathML(math) {
    const ann = math.querySelector('annotation[encoding*="tex" i]');
    return ann ? ann.textContent.trim() : mathmlToText(math).replace(/\s+/g, " ");
  }

  // Pearson/Savvas equation component: fractions are eqDivide > eqNumerator + eqDenominator.
  function eqToText(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1 || node.classList.contains("eqCaret")) return "";
    const cls = typeof node.className === "string" ? node.className : "";
    const inner = () => [...node.childNodes].map(eqToText).join("");
    if (/\beqDivide\b/.test(cls)) {
      const num = node.querySelector(":scope > .eqNumerator");
      const den = node.querySelector(":scope > .eqDenominator");
      // Wrapped as one unit so "cos" + fraction reads cos((6)/(n)), never cos(6)/n.
      if (num && den) return `((${eqToText(num)})/(${eqToText(den)}))`;
    }
    // Big parentheses/brackets are drawn as SVG, so they have no text of their own.
    const fence = /\beq(Paren|Bracket|Brace|Abs)\w*/.exec(cls);
    if (fence && !node.textContent.trim()) {
      const pair = { Paren: "()", Bracket: "[]", Brace: "{}", Abs: "||" }[fence[1]];
      return /\bright\b/.test(cls) ? pair[1] : pair[0];
    }
    // Σ / ∫ / Π with limits: eqSum > eqSumBase + eqIntLower + eqIntUpper.
    if (/\beq(Sum|Int|Integral|Prod)\b/.test(cls)) {
      const base = node.querySelector(':scope > [class*="Base"]')?.textContent.trim() || "∑";
      const lo = node.querySelector(":scope > .eqIntLower");
      const hi = node.querySelector(":scope > .eqIntUpper");
      const body = (el) => [...el.childNodes].map(eqToText).join(""); // contents only: not wrapped twice
      return `${base}${lo ? `_(${body(lo)})` : ""}${hi ? `^(${body(hi)})` : ""} `;
    }
    // Limits under/over other operators (lim with n→∞ underneath, etc.).
    if (/\beq\w*(Lower|Under|Below)\b/.test(cls)) return `_(${inner()}) `;
    if (/\beq\w*(Upper|Over|Above)\b/.test(cls) && !/\beqOverline\b/.test(cls)) return `^(${inner()}) `;
    // Exact class names only: the inner eqSupContent must not count as a second exponent.
    if (/\b(eqSuperscript|eqSup|eqExponent)\b/.test(cls)) return `^(${inner()})`;
    if (/\b(eqSubscript|eqSub)\b/.test(cls)) return `_(${inner()})`;
    if (/\beq(Sqrt|Radical|Root)\b/.test(cls)) return `sqrt(${inner()})`;
    return inner();
  }

  // Returns a text form of a rendered math element, or null if el isn't math.
  function mathText(el) {
    const tag = el.tagName;
    if (el.classList.contains("eqLabel")) {
      const d = el.querySelector(".eqDocument");
      return d ? eqToText(d).replace(/\s+/g, " ").trim() : el.getAttribute("aria-label") || "";
    }
    if (tag === "SCRIPT" && /^math\/tex/i.test(el.type)) return el.textContent.trim(); // MathJax 2 source
    if (tag.toLowerCase() === "math") return texFromMathML(el);
    if (el.classList.contains("katex")) {
      const ann = el.querySelector('annotation[encoding*="tex" i]');
      if (ann) return ann.textContent.trim();
    }
    if (tag === "MJX-CONTAINER") {
      const mml = el.querySelector("mjx-assistive-mml math, math");
      if (mml) return texFromMathML(mml);
      return el.getAttribute("aria-label") || el.textContent.trim();
    }
    if (el.classList.contains("mq-math-mode") && !el.classList.contains("mq-editable-field")) {
      return el.getAttribute("aria-label") || el.textContent.trim();
    }
    if (el.getAttribute("role") === "math") {
      return el.getAttribute("aria-label") || el.getAttribute("alt") || el.textContent.trim();
    }
    if (tag === "IMG") {
      // Many sites render equations as images with the LaTeX in alt.
      const alt = el.getAttribute("alt") || "";
      return /[=+\-^\\]|\d/.test(alt) ? alt : null;
    }
    return null;
  }

  // MathJax 2 renders next to a <script type="math/tex">; skip the rendered copy.
  function isMathJax2Render(el) {
    return [...el.classList].some((c) => c.startsWith("MathJax"));
  }

  const INNER_EDITABLE = 'textarea, input:not([type=hidden]), [contenteditable=""], [contenteditable="true"]';

  // Effectively invisible: the 1px / transparent / off-screen inputs editors use to catch keys.
  function looksHidden(el) {
    const r = el.getBoundingClientRect();
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return r.width <= 2 || r.height <= 2 || +cs.opacity < 0.05 || r.right < 0 || r.bottom < 0 ||
      cs.clipPath !== "none" || cs.clip.startsWith("rect");
  }

  // Custom math editors (Savvas/Pearson "equation" widgets, MathLive, etc.): a drawn
  // expression plus a hidden input that receives keystrokes. Treat the whole thing as one field.
  function isMathWidget(el) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
    if (el.tagName === "MATH-FIELD") return true;
    if (el.classList.contains("eqLabel")) return false; // display-only equation
    const cls = typeof el.className === "string" ? el.className : "";
    const label = el.getAttribute("aria-label") || "";
    const named = el.getAttribute("role") === "textbox" || /response|answer|enter/i.test(label);
    if (!named) return false;
    if (/equation|editor|math|formula/i.test(cls)) return true;
    const inner = el.querySelectorAll(INNER_EDITABLE);
    return inner.length === 1 && looksHidden(inner[0]);
  }

  // A blank inside a multiple-choice option is often disabled until that option is picked.
  const inChoice = (el) => !!el.parentElement?.closest(CHOICE_CONTAINER);

  function fieldKind(el) {
    if (el.closest?.(".mq-editable-field") === el) return "mathfield";
    if (el.closest?.(".mq-editable-field")) return null; // inner parts of a MathQuill field
    if (isMathWidget(el)) return "mathfield";
    const role = el.getAttribute("role");
    if (CHOICE_ROLES.has(role) && el.tagName !== "INPUT") {
      return el.getAttribute("aria-disabled") === "true" ? null : "ariachoice";
    }
    if (el.tagName === "INPUT") {
      if (el.readOnly) return null;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "radio" || type === "checkbox") {
        // A native radio inside an ARIA option is the same choice; the option is reported.
        return el.disabled || el.parentElement?.closest(ARIA_CHOICE) ? null : "choice";
      }
      if (TEXT_INPUT_TYPES.has(type)) return !el.disabled || inChoice(el) ? "input" : null;
      return null;
    }
    if (el.tagName === "TEXTAREA") return el.readOnly || (el.disabled && !inChoice(el)) ? null : "input";
    if (el.tagName === "SELECT") return el.disabled && !inChoice(el) ? null : "select";
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return "editable";
    return null;
  }

  function isChecked(el, kind) {
    if (kind === "choice") return el.checked;
    return el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true";
  }

  function fieldMarker(id, el, kind) {
    const disabled = el.disabled ? " disabled" : "";
    switch (kind) {
      case "input": {
        const type = el.tagName === "TEXTAREA" ? "textarea" : el.type || "text";
        const val = el.value ? ` value="${el.value}"` : "";
        const hint = el.placeholder || el.getAttribute("aria-label");
        return ` [[INPUT id=${id} type=${type}${val}${hint ? ` hint="${hint}"` : ""}${disabled}]] `;
      }
      case "editable":
        return ` [[INPUT id=${id} type=text]] `;
      case "mathfield": {
        // aria-labelledby often holds the lead-in, like "S_n =".
        const labelledBy = (el.getAttribute("aria-labelledby") || el.querySelector("[aria-labelledby]")?.getAttribute("aria-labelledby") || "")
          .split(/\s+/).map((lid) => lid && el.ownerDocument.getElementById(lid)?.textContent.trim()).filter(Boolean).join(" ");
        const hint = [labelledBy, el.getAttribute("aria-label")].filter(Boolean).join(" · ");
        return ` [[MATHFIELD id=${id}${hint ? ` hint="${hint}"` : ""}]] `;
      }
      case "select": {
        const opts = [...el.options].map((o) => o.text.trim()).filter(Boolean).join(" | ");
        return ` [[SELECT id=${id} options="${opts}"${disabled}]] `;
      }
      case "choice":
      case "ariachoice": {
        const type = kind === "choice" ? el.type : /checkbox/.test(el.getAttribute("role")) ? "checkbox" : "radio";
        const label = kind === "ariachoice" && !el.textContent.trim() ? ` "${el.getAttribute("aria-label") || ""}"` : "";
        return `\n[[CHOICE id=${id} kind=${type}${isChecked(el, kind) ? " selected" : ""}]]${label} `;
      }
    }
  }

  // ---------- MyLab (Pearson XL player) ----------
  // The question lives in xl.player.ContentPanel: a top pane (the problem) and a bottom pane
  // (what to answer), grouped into "Part N" steps. Answer boxes are eqEditor widgets with ids
  // like S1; multiple choice is an xlMultipleChoice container (M1) of lettered radio options.

  function findMylabRoot() {
    const panel = document.querySelector('[data-dojo-type="xl.player.ContentPanel"], #xl_player_ContentPanel_0, .contentPanel');
    if (panel) return panel;
    const holders = [...document.querySelectorAll(".contentHolder")];
    if (!holders.length || !document.querySelector(".xlMultipleChoice, .equation.eqEditor, .equation.eqLabel")) return null;
    let root = holders[0];
    while (root.parentElement && !holders.every((h) => root.contains(h))) root = root.parentElement;
    return root;
  }

  // A lettered option's letter, e.g. "A" from its "A." label.
  function optionLetter(answer, index) {
    const label = answer.querySelector("label");
    const own = label && [...label.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("").trim();
    const m = /^([A-Z])[.)]?$/i.exec(own || "") || /^([A-Z])[.)]\s/i.exec(answer.querySelector("input")?.getAttribute("aria-label") || "");
    return (m ? m[1] : String.fromCharCode(65 + index)).toUpperCase();
  }

  // Paragraph tags (¶N) let the model say which part of the page each question is.
  // In MyLab mode, boxes keep their MyLab ids and multiple choice becomes one lettered list.
  function snapshotPage(root, prefix, mylab = false) {
    const out = [];
    fields = new Map();
    blocks = new Map();
    foundMath = [];
    let next = 1;
    let nextBlock = 1;
    const blockStack = [root];
    const tagged = new Set();

    const newId = (el) => (mylab && el.id && !fields.has(prefix + el.id) ? prefix + el.id : prefix + next++);

    // An option's text with its math, registering any answer box inside it.
    function optionText(node) {
      const parts = [];
      (function visit(n) {
        if (n.nodeType === 3) return void parts.push(n.nodeValue);
        if (n.nodeType !== 1 || n.classList.contains("eqAccessibleLabel") || SKIP_TAGS.has(n.tagName)) return;
        const tex = mathText(n);
        if (tex != null) {
          if (tex) {
            parts.push(` $${tex}$ `);
            foundMath.push(n);
          }
          return;
        }
        const kind = fieldKind(n);
        if (kind && kind !== "choice") {
          const id = newId(n);
          fields.set(id, { el: n, kind });
          return void parts.push(fieldMarker(id, n, kind));
        }
        n.childNodes.forEach(visit);
      })(node);
      return parts.join("").replace(/\s+/g, " ").trim();
    }

    function choiceGroup(group) {
      const id = newId(group);
      const options = new Map();
      const lines = [];
      let answers = [...group.querySelectorAll('.mcAnswerOverflow, [data-dojo-type$="MultipleChoiceAnswer"]')];
      if (!answers.length) answers = [...group.querySelectorAll("input[type=radio], input[type=checkbox]")].map((i) => i.parentElement);
      answers.forEach((answer, i) => {
        const input = answer.querySelector("input[type=radio], input[type=checkbox]");
        if (!input) return;
        const letter = optionLetter(answer, i);
        options.set(letter, input);
        const content = answer.querySelector(".mcAnswerContent");
        const spoken = (input.getAttribute("aria-label") || "").replace(/^[A-Z][.)]\s*/i, "").replace(/\s+/g, " ").trim();
        let text = content && optionText(content);
        // Options with math also get MyLab's read-aloud form: it's exact where the layout isn't
        // ("cosine StartFraction 6 Over n EndFraction" is cos(6/n), not cos(6)/n).
        if (!text) text = spoken;
        else if (spoken && text.includes("$")) text += ` (read aloud: "${spoken}")`;
        lines.push(`${letter}) ${text}${input.checked ? "  (selected)" : ""}`);
      });
      const many = !!group.querySelector("input[type=checkbox]") ||
        answers.some((a) => /multi:\s*[1-9]/.test(a.getAttribute("data-dojo-props") || ""));
      fields.set(id, { el: group, kind: "choicegroup", options, many });
      tagBlock();
      out.push(`\n[[CHOICES id=${id} pick=${many ? "many" : "one"}]]\n${lines.join("\n")}\n`);
    }

    function tagBlock() {
      const b = blockStack[blockStack.length - 1];
      if (tagged.has(b)) return;
      tagged.add(b);
      const id = prefix + nextBlock++;
      blocks.set(id, b);
      out.push(`\n¶${id} `);
    }

    function walk(node) {
      if (node.nodeType === 3) {
        const t = node.nodeValue.replace(/\s+/g, " ");
        if (t.trim()) {
          tagBlock();
          out.push(t);
        }
        return;
      }
      if (node.nodeType !== 1 || node === host) return;
      const el = node;

      const tex = mathText(el);
      if (tex != null) {
        if (tex) {
          tagBlock();
          out.push(` $${tex}$ `);
          // The drawn layout can be ambiguous; the spoken form is exact.
          const spoken = el.classList.contains("eqLabel") && el.getAttribute("aria-label");
          if (spoken) out.push(`(read aloud: "${spoken.replace(/\s+/g, " ")}") `);
          foundMath.push(el);
        }
        return;
      }
      if (SKIP_TAGS.has(el.tagName) || isMathJax2Render(el)) return;
      // Custom-styled radios/checkboxes are often hidden themselves while their label shows.
      const isNativeChoice = el.tagName === "INPUT" && /^(radio|checkbox)$/i.test(el.type);
      if (!isNativeChoice && !isVisible(el)) return;
      if (mylab) {
        if (el.tagName === "H4" && el.classList.contains("sr-only")) return; // "Question content area top"
        if (el.classList.contains("xlMultipleChoice")) return choiceGroup(el);
      }

      const kind = fieldKind(el);
      if (kind) {
        const id = newId(el);
        fields.set(id, { el, kind });
        tagBlock();
        out.push(fieldMarker(id, el, kind));
        // Editables and ARIA options hold their own text (an option's label, math, or blanks).
        if (kind !== "editable" && kind !== "ariachoice") return;
      }

      const block = BLOCK_TAGS.has(el.tagName);
      if (block) {
        out.push("\n");
        blockStack.push(el);
      }
      for (const child of el.shadowRoot ? el.shadowRoot.childNodes : []) walk(child);
      for (const child of el.childNodes) walk(child);
      if (block) {
        blockStack.pop();
        out.push("\n");
      }
    }

    walk(root);
    let text = out.join("").replace(/[ \t]+/g, " ").replace(/ *\n[\n ]*/g, "\n").trim();
    if (text.length > MAX_SNAPSHOT) text = text.slice(0, MAX_SNAPSHOT) + "\n[page truncated]";
    return text;
  }

  // ---------- Filling answers ----------

  function setNativeValue(el, value) {
    // Use the prototype setter so React/Vue controlled inputs see the change.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // US-keyboard key for each symbol: [code, keyCode, needs Shift]. A symbol's own char code is
  // not its keyCode: "(" is 40 (ArrowDown), "." is 46 (Delete), "-" is 45 (Insert), so editors
  // that read keyCode would move the cursor or delete instead of typing.
  const SYMBOL_KEYS = {
    "(": ["Digit9", 57, true], ")": ["Digit0", 48, true], "^": ["Digit6", 54, true], "*": ["Digit8", 56, true],
    "!": ["Digit1", 49, true], "%": ["Digit5", 53, true], "+": ["Equal", 187, true], "=": ["Equal", 187, false],
    "-": ["Minus", 189, false], "_": ["Minus", 189, true], "/": ["Slash", 191, false], ".": ["Period", 190, false],
    ",": ["Comma", 188, false], "<": ["Comma", 188, true], ">": ["Period", 190, true], " ": ["Space", 32, false],
    "\\": ["Backslash", 220, false], "|": ["Backslash", 220, true], "[": ["BracketLeft", 219, false],
    "]": ["BracketRight", 221, false], "{": ["BracketLeft", 219, true], "}": ["BracketRight", 221, true],
  };

  function keyInit(ch) {
    let code = "", keyCode = 0, shiftKey = false;
    if (/[a-z]/i.test(ch)) [code, keyCode, shiftKey] = ["Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), ch !== ch.toLowerCase()];
    else if (/\d/.test(ch)) [code, keyCode] = ["Digit" + ch, ch.charCodeAt(0)];
    else if (SYMBOL_KEYS[ch]) [code, keyCode, shiftKey] = SYMBOL_KEYS[ch];
    return { key: ch, code, keyCode, which: keyCode, shiftKey, bubbles: true, cancelable: true, composed: true };
  }

  function pointerClick(el) {
    const win = el.ownerDocument.defaultView;
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      el.dispatchEvent(new (type.startsWith("pointer") ? win.PointerEvent : win.MouseEvent)(type, at));
    }
    el.click();
  }

  // Clicks a math widget so it takes focus, then finds the element that receives its keys.
  async function focusWidget(el) {
    const doc = el.ownerDocument;
    pointerClick(el);
    await sleep(30);
    const active = doc.activeElement;
    if (active && active !== doc.body && (el.contains(active) || active === el)) return active;
    const inner = el.querySelector(INNER_EDITABLE);
    const target = inner || el;
    target.focus?.({ preventScroll: true });
    return target;
  }

  // Types text one key at a time. Editors that handle keydown/keypress themselves cancel
  // the event; otherwise insertText delivers a real input event to the focused element.
  async function typeInto(target, text) {
    const doc = target.ownerDocument;
    const win = doc.defaultView;
    for (const ch of text) {
      if (ch === "→") {
        // Right arrow: steps the editor's cursor out of an exponent or fraction.
        const arrow = { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new win.KeyboardEvent("keydown", arrow));
        target.dispatchEvent(new win.KeyboardEvent("keyup", arrow));
        await sleep(12);
        continue;
      }
      const init = keyInit(ch);
      const down = target.dispatchEvent(new win.KeyboardEvent("keydown", init));
      if (down) {
        const press = target.dispatchEvent(new win.KeyboardEvent("keypress", { ...init, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0) }));
        if (press) doc.execCommand("insertText", false, ch);
      }
      target.dispatchEvent(new win.KeyboardEvent("keyup", init));
      await sleep(12);
    }
  }

  async function waitEnabled(el, ms = 1500) {
    for (let t = 0; el.disabled && t < ms; t += 50) await sleep(50);
    return !el.disabled;
  }

  async function fillChoice(el, kind, value) {
    const v = value.trim();
    const want = !/^(false|no|0|off|unchecked|unselected)$/i.test(v);
    const verifiable = kind === "choice" || el.hasAttribute("aria-checked") || el.hasAttribute("aria-selected");
    if (verifiable && isChecked(el, kind) === want) return true;

    pointerClick(el);
    await sleep(80);
    if (!verifiable) return true;
    if (isChecked(el, kind) === want) return true;

    // Some option lists only react to real input: press Space on it for real.
    el.focus?.({ preventScroll: true });
    await chrome.runtime.sendMessage({ type: "trusted-type", text: " " });
    await sleep(80);
    return isChecked(el, kind) === want;
  }

  async function fillField(id, value) {
    const f = fields.get(String(id));
    if (!f || !f.el.isConnected) return false;
    const { el, kind } = f;
    const doc = el.ownerDocument;
    if ("disabled" in el && el.disabled && !(await waitEnabled(el))) {
      flash(el, "fail");
      return false;
    }

    if (kind === "choicegroup") {
      // Answered with letters: "A", or "A, C" for select-all-that-apply.
      const want = new Set(
        value.split(/[\s,;&/]+|\band\b/i).map((t) => t.trim().replace(/[.)]$/, "").toUpperCase()).filter((t) => /^[A-Z]$/.test(t))
      );
      if (!want.size || (!f.many && want.size > 1) || ![...want].every((l) => f.options.has(l))) {
        flash(el, "fail");
        return false;
      }
      let ok = true;
      for (const [letter, input] of f.options) {
        const on = want.has(letter);
        if (on || (f.many && input.checked)) ok = (await fillChoice(input, "choice", on ? "true" : "false")) && ok;
      }
      flash(el, ok ? "ok" : "fail");
      return ok;
    }

    if (kind === "choice" || kind === "ariachoice") {
      const ok = await fillChoice(el, kind, value);
      flash(el, ok ? "ok" : "fail");
      return ok;
    }

    if (kind !== "mathfield") el.focus?.({ preventScroll: true });

    if (kind === "input") {
      setNativeValue(el, value);
    } else if (kind === "select") {
      const want = value.trim().toLowerCase();
      const opt = [...el.options].find(
        (o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want
      );
      if (!opt) return false;
      setNativeValue(el, opt.value);
    } else if (kind === "editable") {
      doc.getSelection().selectAllChildren(el);
      if (!doc.execCommand("insertText", false, value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      }
    } else if (kind === "mathfield") {
      // MathQuill, equation editors, MathLive: they only update their drawing from keystrokes.
      // Ignore whitespace: the blinking caret is a " " span that comes and goes with focus.
      const shown = () => el.textContent.replace(/\s+/g, "");
      const before = shown();
      // Real keystrokes (through the debugger) first: MyLab's editor takes script-made keys for
      // digits and symbols but drops letters, so "\sqrt" and "pi" vanished while the rest typed.
      const target = await focusWidget(el);
      const res = await chrome.runtime.sendMessage({ type: "trusted-type", text: value });
      await sleep(80);
      if (!res?.ok) {
        // No debugger (refused, or another one attached): fall back to script-made keys.
        target.focus({ preventScroll: true });
        await typeInto(target, value);
        await sleep(80);
      }
      if (shown() === before) {
        flash(el, "fail");
        return false;
      }
    }

    el.blur?.();
    flash(el, "ok");
    return true;
  }

  // ---------- Highlights (drawn by each frame in its own document) ----------

  // Hidden / opacity are shared by every frame (and every synced browser) through chrome.storage.sync.
  let look = { hidden: false, opacity: 1, highlights: true };

  // Highlight colors scale with the opacity setting; when hidden or highlights are off there
  // are no rules at all, so marked elements look untouched.
  function pageCss() {
    if (look.hidden || !look.highlights) return "";
    const o = look.opacity;
    const accent = (a) => `rgba(82, 82, 91, ${+(a * o).toFixed(3)})`;
    return `
      [data-ma-mark="ok"] { outline: 2px solid rgba(22, 163, 74, ${o}) !important; outline-offset: 2px; transition: outline-color .3s; }
      [data-ma-mark="fail"] { outline: 2px solid rgba(220, 38, 38, ${o}) !important; outline-offset: 2px; }
      [data-ma-mark="hover"] { outline: 2px dashed ${accent(1)} !important; outline-offset: 2px; }
      [data-ma-found] { outline: 1.5px dashed ${accent(0.8)} !important; outline-offset: 3px; }
      [data-ma-q] { outline: 2px solid ${accent(0.45)} !important; outline-offset: 4px; border-radius: 4px;
                    background-color: ${accent(0.07)} !important; transition: background-color .15s, outline-color .15s; }
      [data-ma-q="active"] { outline-color: ${accent(1)} !important; background-color: ${accent(0.16)} !important; }
    `;
  }

  function ensurePageStyle() {
    if (document.getElementById("math-autopilot-style")) return;
    const style = document.createElement("style");
    style.id = "math-autopilot-style";
    style.textContent = pageCss();
    document.documentElement.appendChild(style);
  }

  function flash(el, state) {
    ensurePageStyle();
    el.setAttribute("data-ma-mark", state);
    if (state === "ok") setTimeout(() => el.removeAttribute("data-ma-mark"), 2500);
  }

  let foundMarked = [];
  let qMarks = []; // { n, el }

  function applyLook() {
    const style = document.getElementById("math-autopilot-style");
    if (style) style.textContent = pageCss();
    if (IS_TOP) ui.applyLook();
  }

  // ---------- Keyboard shortcuts (every frame; focus is often inside a question iframe) ----------

  const { comboOf, DEFAULTS: DEFAULT_KEYS } = globalThis.MA_KEYS;
  let keybinds = { ...DEFAULT_KEYS };

  addEventListener("keydown", (e) => {
    const combo = comboOf(e);
    const action = combo && Object.keys(keybinds).find((a) => keybinds[a] === combo);
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (IS_TOP) ui.hotkey(action);
    else chrome.runtime.sendMessage({ type: "hotkey", action });
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.keybinds) keybinds = { ...DEFAULT_KEYS, ...changes.keybinds.newValue };
    if (changes.hidden || changes.opacity || changes.showHighlights) {
      if (changes.hidden) look.hidden = !!changes.hidden.newValue;
      if (changes.opacity) look.opacity = changes.opacity.newValue ?? 1;
      if (changes.showHighlights) look.highlights = changes.showHighlights.newValue !== false;
      applyLook();
    }
  });

  // ---------- Frame API: what the top frame (via the background) can ask each frame ----------

  const api = {
    // Hidden frames need no check here: nothing in them counts as visible, so they read as empty.
    ready: () => !!document.body,

    // On MyLab, only the question panel is read; elsewhere the whole page (or the picked area).
    snapshot(prefix = "", root = null) {
      if (!api.ready()) return { text: "" };
      const mylabRoot = findMylabRoot();
      const mylab = !!mylabRoot && (!root || mylabRoot.contains(root));
      const text = snapshotPage(root || mylabRoot || document.body, prefix, mylab);
      return { text, fields: fields.size, math: foundMath.length, mylab };
    },

    fill: (id, value) => fillField(id, value),

    markFound() {
      api.clearFound();
      if (foundMath.length) ensurePageStyle();
      for (const el of foundMath) el.setAttribute("data-ma-found", "");
      foundMarked = foundMath.slice();
    },

    clearFound() {
      foundMarked.forEach((el) => el.removeAttribute("data-ma-found"));
      foundMarked = [];
    },

    // list: [{ n, refs }] for every problem; each frame marks the paragraphs it owns.
    markQuestions(list) {
      api.clearQuestions();
      for (const { n, refs } of list) {
        const els = (refs || []).map((r) => blocks.get(String(r).replace(/^¶/, "").trim())).filter(Boolean);
        for (const el of els) {
          ensurePageStyle();
          el.setAttribute("data-ma-q", "on");
          qMarks.push({ n, el });
        }
      }
    },

    clearQuestions() {
      for (const m of qMarks) m.el.removeAttribute("data-ma-q");
      qMarks = [];
    },

    hover(n, ids, on) {
      for (const m of qMarks) if (m.n === n) m.el.setAttribute("data-ma-q", on ? "active" : "on");
      for (const id of ids) {
        const el = fields.get(String(id))?.el;
        if (!el) continue;
        if (on && !el.hasAttribute("data-ma-mark")) flash(el, "hover");
        if (!on && el.getAttribute("data-ma-mark") === "hover") el.removeAttribute("data-ma-mark");
      }
    },

    scrollTo(n, fieldId) {
      const el = qMarks.find((m) => m.n === n)?.el || fields.get(String(fieldId))?.el;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
  };

  globalThis.__maApi = api;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ma-call" && api[msg.call]) {
      Promise.resolve()
        .then(() => api[msg.call](...(msg.args || [])))
        .then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (!IS_TOP) return;
    if (msg.type === "toggle-panel") ui.togglePanel();
    if (msg.type === "ma-hotkey") ui.hotkey(msg.action);
  });

  chrome.storage.sync.get({ keybinds: {}, hidden: false, opacity: 1, showHighlights: true }).then((s) => {
    keybinds = { ...DEFAULT_KEYS, ...s.keybinds };
    look = { hidden: s.hidden, opacity: s.opacity, highlights: s.showHighlights };
    applyLook();
  });

  // Child frames stop here; the panel lives in the top frame only.
  if (!IS_TOP) return;

  // ---------- Panel UI (top frame) ----------

  const PREFS = { autoFill: true, includeScreenshot: false, showButton: true, matchPage: true, showHighlights: true, fabPos: null };
  let prefs = { ...PREFS };
  let scopeEl = null; // element chosen with "Pick"
  let busy = false;
  let activeFrames = [0]; // frames that reported content in the last scan
  let lastSnapshot = "";

  host = document.createElement("div");
  host.id = "math-autopilot-root";
  host.setAttribute("data-ma-ui", "");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; inset: auto;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .vars {
        --bg: #ffffff; --bg-2: #f6f6f9; --ink: #18181b; --ink-2: #5b5b66; --line: #e6e6ec;
        --accent: #1c1c20; --accent-ink: #ffffff; --knob-on: #ffffff;
        --btn: linear-gradient(180deg, #3b3b41, #16161a);
        --btn-depth: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.45), 0 1px 2px rgba(0,0,0,.22);
        --brand: linear-gradient(180deg, #3b3b41, #1a1a1e 55%, #08080a); --ok: #16a34a; --bad: #dc2626;
        --shadow: 0 18px 50px -12px rgba(20, 20, 40, .28), 0 2px 6px rgba(20, 20, 40, .08);
      }
      @media (prefers-color-scheme: dark) {
        .vars { --bg: #1c1c22; --bg-2: #25252d; --ink: #f2f2f5; --ink-2: #a3a3ae; --line: #33333d;
                --accent: #e6e6ea; --accent-ink: #18181b; --knob-on: #18181b;
                --btn: linear-gradient(180deg, #fafafb, #c6c6cd);
                --btn-depth: inset 0 1px 0 #ffffff, inset 0 -1px 0 rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.5);
                --shadow: 0 18px 50px -12px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.3); }
      }
      .fab {
        position: fixed; width: 52px; height: 52px; border-radius: 16px; border: none; cursor: grab;
        background: var(--brand); color: var(--accent-ink); box-shadow: var(--shadow);
        display: grid; place-items: center; font-size: 24px; font-weight: 600; line-height: 1;
        transition: transform .15s ease, box-shadow .15s ease; user-select: none;
      }
      .mark { width: 100%; height: 100%; display: block; }
      /* Raised look for the brand (unmatched) button and logo: lit top edge, shadowed glyph. */
      .vars:not(.matched) .logo { box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -2px 0 rgba(0,0,0,.5); }
      .vars:not(.matched) .mark { color: #f4f4f6; filter: drop-shadow(0 1.5px 0 #55555c) drop-shadow(0 2px 2px rgba(0,0,0,.6)); }
      .fab .mark { width: 50px; height: 50px; }
      .fab:hover { transform: translateY(-2px); }
      .vars:not(.matched) .fab { box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -2px 0 rgba(0,0,0,.5), var(--shadow); }
      .fab:active { cursor: grabbing; }
      .fab.busy::after {
        content: ""; position: absolute; inset: -4px; border-radius: 19px;
        border: 2px solid var(--accent); border-right-color: transparent; animation: spin .9s linear infinite;
      }
      .fab[hidden] { display: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
      /* Matching the page: the button and logo take the page colour instead of the accent. */
      .vars.matched .fab { background: var(--accent); color: var(--accent-ink); border: none; }
      .vars.matched .fab.busy::after { border-color: var(--ink-2); border-right-color: transparent; }
      .vars.matched .logo { background: var(--accent); color: var(--accent-ink); }
      .vars.matched button.primary { background: var(--accent); box-shadow: none; }
      .vars.matched .switch input:checked + i { box-shadow: none; }
      .vars.matched button.primary:hover, .vars.matched .fab:hover { filter: none; background: var(--line); }
      .vars.matched .switch i { background: var(--line); }
      .vars.matched .switch input:checked + i { background: var(--switch-on); }
      .vars.matched .switch i::after { background: var(--knob); box-shadow: none; }
      .vars.matched .spinner { border-top-color: var(--ink-2); }
      .vars.matched .card:hover { border-color: var(--switch-on); }
      /* The accent is now nearly the page colour, so text that used it switches to the muted ink. */
      .vars.matched .status a, .vars.matched footer button, .vars.matched .scope button { color: var(--ink-2); text-decoration: underline; }
      .vars.matched .panel, .vars.matched .fab { transition: background-color .25s, color .25s, border-color .25s, opacity .16s, transform .16s; }

      .panel {
        position: fixed; width: 360px; max-height: min(620px, calc(100vh - 32px)); display: flex; flex-direction: column;
        background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 18px;
        box-shadow: var(--shadow); overflow: hidden; font-size: 14px;
        opacity: 0; transform: translateY(8px) scale(.98); pointer-events: none; transition: opacity .16s, transform .16s;
      }
      .panel.open { opacity: 1; transform: none; pointer-events: auto; }
      .settings-view { display: none; }
      .panel.in-settings .body, .panel.in-settings footer.on { display: none; }
      .panel.in-settings .settings-view { display: block; }
      .settings-view iframe { display: block; width: 100%; height: min(540px, calc(100vh - 100px)); border: 0; background: transparent; color-scheme: normal; }
      .icon-btn.settings { font-size: 18px; }
      header { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px 16px; }
      .logo { width: 28px; height: 28px; border-radius: 8px; background: var(--brand); color: var(--accent-ink);
              display: grid; place-items: center; font-weight: 700; font-size: 15px; }
      h1 { font-size: 15px; font-weight: 650; margin: 0; flex: 1; letter-spacing: -.01em; }
      .icon-btn { width: 30px; height: 30px; border-radius: 9px; border: none; background: transparent; color: var(--ink-2);
                  cursor: pointer; display: grid; place-items: center; font-size: 16px; }
      .icon-btn:hover { background: var(--bg-2); color: var(--ink); }

      .body { padding: 4px 16px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
      .actions { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
      button.primary, button.secondary {
        height: 40px; border-radius: 11px; font-size: 14px; font-weight: 600; cursor: pointer; padding: 0 14px;
        transition: filter .12s, background .12s;
      }
      button.primary { background: var(--btn); color: var(--accent-ink); border: none; box-shadow: var(--btn-depth); }
      button.primary:hover { filter: brightness(1.07); }
      button.secondary { background: var(--bg-2); color: var(--ink); border: 1px solid var(--line); }
      button.secondary:hover { background: var(--line); }
      button:disabled { opacity: .55; cursor: default; filter: none; }
      .scope { display: none; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2);
               background: var(--bg-2); border-radius: 10px; padding: 7px 10px; }
      .scope.on { display: flex; }
      .scope span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .scope button { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 12.5px; font-weight: 600; }

      .toggles { display: flex; flex-direction: column; gap: 2px; }
      label.toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; cursor: pointer; color: var(--ink-2); font-size: 13px; }
      .switch { position: relative; width: 34px; height: 20px; flex: none; }
      .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
      .switch i { position: absolute; inset: 0; border-radius: 99px; background: var(--line); transition: background .15s; }
      .switch i::after { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; border-radius: 50%;
                         background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
      .switch input:checked + i { background: var(--btn); box-shadow: var(--btn-depth); }
      .switch input:checked + i::after { background: var(--knob-on); }
      .switch input:checked + i::after { transform: translateX(14px); }

      .status { display: none; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-2); padding: 2px 0; }
      .status.on { display: flex; }
      .status.error { color: var(--bad); }
      .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent);
                 animation: spin .8s linear infinite; flex: none; }
      .status.error .spinner, .status.done .spinner { display: none; }
      .status a { color: var(--accent); cursor: pointer; font-weight: 600; }

      .results { display: flex; flex-direction: column; gap: 8px; }
      .card { border: 1px solid var(--line); border-radius: 13px; padding: 11px 12px; display: flex; flex-direction: column; gap: 6px; }
      .card:hover { border-color: var(--accent); }
      .card.pulse { animation: pulse .9s ease; }
      @keyframes pulse { 30% { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); } }
      .q-head { display: flex; gap: 8px; align-items: flex-start; }
      .num { flex: none; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 99px; background: var(--accent); color: var(--accent-ink);
             font-size: 11px; font-weight: 700; display: grid; place-items: center; margin-top: 1px; }
      .q { font-size: 12.5px; color: var(--ink-2); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .a-row { display: flex; align-items: center; gap: 8px; }
      .a { flex: 1; font-size: 16px; font-weight: 650; word-break: break-word; font-variant-numeric: tabular-nums; }
      .fill { height: 28px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg-2); color: var(--ink);
              font-size: 12px; font-weight: 600; padding: 0 10px; cursor: pointer; flex: none; }
      .fill:hover { border-color: var(--accent); }
      .fill.done { color: var(--ok); border-color: transparent; background: transparent; cursor: default; }
      .fill.part { color: #b45309; border-color: transparent; background: transparent; }
      .fill.none { color: var(--ink-2); border-color: transparent; background: transparent; cursor: default; font-weight: 500; }
      details { font-size: 12.5px; color: var(--ink-2); }
      summary { cursor: pointer; user-select: none; width: max-content; }
      details p { margin: 6px 0 0; white-space: pre-wrap; line-height: 1.45; }
      footer { font-size: 11px; color: var(--ink-2); padding: 8px 16px 12px; border-top: 1px solid var(--line); display: none; }
      footer.on { display: block; }
      .credit { font-size: 10.5px; color: var(--ink-2); opacity: .7; text-align: center; padding: 0 16px 10px; letter-spacing: .02em; flex: none; }
      footer button { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 11px; font-weight: 600; padding: 0; margin-left: 8px; }

      .pick-hl { position: fixed; pointer-events: none; border: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
                 border-radius: 6px; display: none; transition: all .06s; }
      .toast { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 8px); background: var(--ink); color: var(--bg);
               font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 99px; box-shadow: var(--shadow);
               opacity: 0; pointer-events: none; transition: opacity .15s, transform .15s; }
      .toast.on { opacity: 1; transform: translate(-50%, 0); }
      .pick-tip { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg);
                  font-size: 13px; padding: 8px 14px; border-radius: 99px; display: none; box-shadow: var(--shadow); }
    </style>
    <div class="vars">
      <button class="fab" title="Hydramath (Alt+M)" aria-label="Open Hydramath"><svg class="mark" viewBox="7.5 -2.5 128 128" aria-hidden="true"><path d="M84 34H38l25 30-25 30h46" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><path d="M100 22c1.6 7.4 3.6 9.4 11 11-7.4 1.6-9.4 3.6-11 11-1.6-7.4-3.6-9.4-11-11 7.4-1.6 9.4-3.6 11-11z" fill="currentColor"/></svg></button>
      <section class="panel" role="dialog" aria-label="Hydramath">
        <header>
          <div class="logo"><svg class="mark" viewBox="7.5 -2.5 128 128" aria-hidden="true"><path d="M84 34H38l25 30-25 30h46" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><path d="M100 22c1.6 7.4 3.6 9.4 11 11-7.4 1.6-9.4 3.6-11 11-1.6-7.4-3.6-9.4-11-11 7.4-1.6 9.4-3.6 11-11z" fill="currentColor"/></svg></div>
          <h1>Hydramath</h1>
          <button class="icon-btn settings" title="Settings" aria-label="Settings">⚙</button>
          <button class="icon-btn close" title="Close" aria-label="Close">✕</button>
        </header>
        <div class="body">
          <div class="actions">
            <button class="primary solve">Solve this page</button>
            <button class="secondary pick" title="Click a question on the page to solve only that part">Pick</button>
          </div>
          <div class="scope"><span></span><button class="clear-scope">Clear</button></div>
          <div class="toggles">
            <label class="toggle">Fill answers automatically
              <span class="switch"><input type="checkbox" data-pref="autoFill"><i></i></span></label>
            <label class="toggle">Include a screenshot (for math in images)
              <span class="switch"><input type="checkbox" data-pref="includeScreenshot"><i></i></span></label>
            <label class="toggle">Match page background
              <span class="switch"><input type="checkbox" data-pref="matchPage"><i></i></span></label>
            <label class="toggle">Show highlights
              <span class="switch"><input type="checkbox" data-pref="showHighlights"><i></i></span></label>
          </div>
          <div class="status"><div class="spinner"></div><span></span></div>
          <div class="results"></div>
        </div>
        <footer></footer>
        <div class="settings-view"></div>
        <div class="credit">Developed by Logic</div>
      </section>
      <div class="pick-hl"></div>
      <div class="pick-tip">Click the question to solve · Esc to cancel</div>
      <div class="toast" role="status"></div>
    </div>
  `;

  const $ = (s) => shadow.querySelector(s);
  const fab = $(".fab");
  const panel = $(".panel");
  const statusEl = $(".status");
  const resultsEl = $(".results");
  const footer = $("footer");

  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // --- Position: FAB is draggable; panel opens next to it. ---
  function placeFab() {
    const pos = prefs.fabPos;
    const x = pos ? Math.min(Math.max(pos.x, 8), innerWidth - 60) : innerWidth - 76;
    const y = pos ? Math.min(Math.max(pos.y, 8), innerHeight - 60) : innerHeight - 96;
    fab.style.left = x + "px";
    fab.style.top = y + "px";
    placePanel();
  }

  function placePanel() {
    const r = fab.getBoundingClientRect();
    const w = Math.min(360, innerWidth - 16);
    panel.style.width = w + "px";
    const right = r.left + r.width / 2 > innerWidth / 2;
    let left = right ? r.right - w : r.left;
    left = Math.min(Math.max(left, 8), innerWidth - w - 8);
    panel.style.left = left + "px";
    if (r.top < innerHeight / 2) {
      panel.style.top = r.bottom + 10 + "px";
      panel.style.bottom = "auto";
    } else {
      panel.style.bottom = innerHeight - r.top + 10 + "px";
      panel.style.top = "auto";
    }
  }

  let drag = null;
  fab.addEventListener("pointerdown", (e) => {
    drag = { dx: e.clientX - fab.offsetLeft, dy: e.clientY - fab.offsetTop, moved: false };
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const x = e.clientX - drag.dx;
    const y = e.clientY - drag.dy;
    if (!drag.moved && Math.hypot(x - fab.offsetLeft, y - fab.offsetTop) < 4) return;
    drag.moved = true;
    prefs.fabPos = { x, y };
    placeFab();
  });
  fab.addEventListener("pointerup", () => {
    if (drag?.moved) {
      savePrefs({ fabPos: prefs.fabPos });
      matchBackground();
    } else togglePanel();
    drag = null;
  });
  addEventListener("resize", () => {
    placeFab();
    matchBackground();
  });

  function togglePanel(force) {
    mount();
    const open = force ?? !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    placePanel();
    if (open) matchBackground();
  }

  // --- Match the page's background colour ---
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const BLACK = { r: 0, g: 0, b: 0, a: 1 };

  function parseColor(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const alpha = p[3] == null ? 1 : p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    return { r: +p[0], g: +p[1], b: +p[2], a: alpha };
  }

  // Background layers under a point, topmost first; descends into same-origin iframes.
  // Returns true once an opaque layer is reached.
  function layersAt(doc, x, y, out) {
    const bgOf = (el) => el && parseColor(el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor);
    let hitBody = false;
    for (const el of doc.elementsFromPoint(x, y)) {
      if (el.hasAttribute("data-ma-ui")) continue;
      if (el === doc.body) hitBody = true;
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let inner = null;
        try {
          inner = el.contentDocument;
        } catch {}
        if (!inner) {
          out.push(WHITE); // cross-origin frame: can't look inside; question frames are almost always white
          return true;
        }
        const r = el.getBoundingClientRect();
        if (layersAt(inner, x - r.left - el.clientLeft, y - r.top - el.clientTop, out)) return true;
      }
      const c = bgOf(el);
      if (c && c.a > 0) {
        out.push(c);
        if (c.a >= 0.99) return true;
      }
    }
    // CSS: when <html> has no background, <body>'s paints the whole window, even outside its box.
    const root = bgOf(doc.documentElement);
    const body = bgOf(doc.body);
    if ((!root || root.a === 0) && !hitBody && body?.a > 0) {
      out.push(body);
      if (body.a >= 0.99) return true;
    }
    return false;
  }

  function colorAt(x, y) {
    const layers = [];
    if (!layersAt(document, x, y, layers)) layers.push(WHITE); // browser default canvas
    // Composite bottom-up.
    return layers.reduceRight((under, top) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    }));
  }

  // Samples a few points under the panel (or the button) and keeps the most common colour,
  // so one stray element under the centre doesn't decide it.
  function sampleBackground() {
    const target = panel.classList.contains("open") ? panel : fab;
    const r = target.getBoundingClientRect();
    const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]
      .map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy])
      .filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    const counts = new Map();
    for (const [x, y] of pts) {
      const c = colorAt(x, y);
      const key = [c.r, c.g, c.b].map(Math.round).join(",");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ["255,255,255"];
    const [cr, cg, cb] = best.split(",").map(Number);
    return { r: cr, g: cg, b: cb, a: 1 };
  }

  const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  const cssColor = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

  function luminance({ r, g, b }) {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  // Everything derives from the page colour: text is a strong tint toward black or white,
  // and buttons, switches and borders are only a small step darker (light pages) or
  // lighter (dark pages) than the page, so nothing stands out.
  function themeFor(bg) {
    const dark = luminance(bg) < 0.3;
    const ink = mix(bg, dark ? WHITE : BLACK, 0.9);
    const shade = (t) => cssColor(mix(bg, ink, t));
    return {
      "--bg": cssColor(bg),
      "--bg-2": shade(0.04),
      "--ink": cssColor(ink),
      "--ink-2": shade(0.6),
      "--line": shade(0.1),
      "--accent": shade(0.09), // button fill
      "--accent-ink": shade(0.72), // button label
      "--switch-on": shade(0.3),
      "--knob": cssColor(bg),
      "--shadow": dark
        ? "0 12px 32px -12px rgba(0, 0, 0, .6)"
        : "0 12px 32px -14px rgba(0, 0, 0, .18), 0 1px 3px rgba(0, 0, 0, .06)",
    };
  }

  const THEME_VARS = Object.keys(themeFor(WHITE));

  function matchBackground() {
    const vars = $(".vars");
    vars.classList.toggle("matched", !!prefs.matchPage);
    if (!prefs.matchPage) {
      THEME_VARS.forEach((v) => vars.style.removeProperty(v));
      return;
    }
    if (!host.isConnected || look.hidden) return;
    for (const [k, v] of Object.entries(themeFor(sampleBackground()))) vars.style.setProperty(k, v);
    sendTheme();
  }

  let matchTimer = 0;
  addEventListener("scroll", () => {
    clearTimeout(matchTimer);
    matchTimer = setTimeout(matchBackground, 250);
  }, true);

  $(".close").addEventListener("click", () => togglePanel(false));

  // --- Settings view ---
  // The settings page is an extension frame inside the panel: websites can watch keystrokes
  // typed into their own pages (including this panel), but not into an extension frame, so
  // the API key and shortcut recorder stay private.
  const EXT_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
  let settingsFrame = null;
  let settingsReady = false; // set when the settings page says it's loaded and listening

  function sendTheme() {
    // Until then the frame is a blank document with the page's origin, and Chrome rejects
    // (and logs) messages addressed to the extension.
    if (!settingsReady || !settingsFrame?.contentWindow) return;
    const cs = getComputedStyle($(".vars"));
    const vars = {};
    for (const v of ["--bg", "--bg-2", "--ink", "--ink-2", "--line", "--accent", "--accent-ink", "--switch-on"]) {
      const value = cs.getPropertyValue(v).trim();
      if (value) vars[v] = value;
    }
    settingsFrame.contentWindow.postMessage({ type: "ma-theme", vars }, EXT_ORIGIN);
  }

  function showSettings(on) {
    togglePanel(true);
    panel.classList.toggle("in-settings", on);
    $("h1").textContent = on ? "Settings" : "Hydramath";
    const btn = $(".settings");
    btn.textContent = on ? "‹" : "⚙";
    btn.title = on ? "Back" : "Settings";
    btn.setAttribute("aria-label", btn.title);
    if (on && !settingsFrame) {
      settingsFrame = document.createElement("iframe");
      settingsFrame.title = "Hydramath settings";
      settingsFrame.src = chrome.runtime.getURL("options.html?embedded");
      $(".settings-view").append(settingsFrame);
    }
    if (on) sendTheme();
  }

  $(".settings").addEventListener("click", () => showSettings(!panel.classList.contains("in-settings")));
  addEventListener("message", (e) => {
    if (settingsFrame && e.source === settingsFrame.contentWindow && e.data?.type === "ma-settings-ready") {
      settingsReady = true;
      sendTheme();
    }
  });

  // --- Preferences ---
  function savePrefs(patch) {
    Object.assign(prefs, patch);
    chrome.storage.sync.set(patch);
  }

  shadow.querySelectorAll("[data-pref]").forEach((input) => {
    input.addEventListener("change", () => savePrefs({ [input.dataset.pref]: input.checked }));
  });

  function applyPrefs() {
    shadow.querySelectorAll("[data-pref]").forEach((input) => (input.checked = !!prefs[input.dataset.pref]));
    fab.hidden = !prefs.showButton;
    placeFab();
    matchBackground();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [k, { newValue }] of Object.entries(changes)) if (k in PREFS) prefs[k] = newValue;
    applyPrefs();
  });

  // --- Status ---
  function setStatus(text, kind = "loading", ...actions) {
    statusEl.className = "status on " + kind;
    const span = statusEl.querySelector("span");
    span.textContent = text;
    for (const action of actions) {
      const a = document.createElement("a");
      a.textContent = " " + action.label;
      a.addEventListener("click", action.run);
      span.append(a);
    }
  }

  function setBusy(on) {
    busy = on;
    fab.classList.toggle("busy", on);
    $(".solve").disabled = on;
    $(".pick").disabled = on;
  }

  // For debugging misses: exactly what the extension read from the page.
  const copyAction = {
    label: "Copy page text",
    run: async (e) => {
      await navigator.clipboard.writeText(lastSnapshot);
      e.target.textContent = " Copied ✓";
    },
  };

  // --- Element picker (top document only) ---
  const pickHl = $(".pick-hl");
  const pickTip = $(".pick-tip");

  function startPick() {
    togglePanel(false);
    pickTip.style.display = "block";
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("click", onPickClick, true);
    document.addEventListener("keydown", onPickKey, true);
  }

  function stopPick() {
    pickHl.style.display = "none";
    pickTip.style.display = "none";
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("click", onPickClick, true);
    document.removeEventListener("keydown", onPickKey, true);
  }

  // Grow tiny targets (a single number) to their nearest block so the question has context.
  function pickTarget(el) {
    let t = el;
    while (t && t !== document.body && t.getBoundingClientRect().height < 40) t = t.parentElement;
    return t || el;
  }

  function onPickMove(e) {
    if (e.composedPath().includes(host)) return;
    const r = pickTarget(e.target).getBoundingClientRect();
    Object.assign(pickHl.style, {
      display: "block", left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px",
    });
  }

  function onPickClick(e) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    scopeEl = pickTarget(e.target);
    stopPick();
    const scope = $(".scope");
    scope.classList.add("on");
    scope.querySelector("span").textContent = "Only: " + (scopeEl.innerText || "selected area").trim().slice(0, 80);
    $(".solve").textContent = "Solve selection";
    togglePanel(true);
    solve();
  }

  function onPickKey(e) {
    if (e.key === "Escape") {
      stopPick();
      togglePanel(true);
    }
  }

  $(".pick").addEventListener("click", startPick);
  $(".clear-scope").addEventListener("click", () => {
    scopeEl = null;
    $(".scope").classList.remove("on");
    $(".solve").textContent = "Solve this page";
  });

  // --- Talking to frames ---
  const frameOf = (id) => +(/^f(\d+)-/.exec(String(id))?.[1] ?? 0);

  // Runs an api call in every active frame; the top frame runs it directly.
  async function callFrames(call, ...args) {
    const others = activeFrames.filter((f) => f !== 0);
    const [local, remote] = await Promise.all([
      activeFrames.includes(0) ? api[call](...args) : undefined,
      others.length ? chrome.runtime.sendMessage({ type: "frames-call", frameIds: others, call, args }) : [],
    ]);
    return [local, ...(remote || []).map((r) => r?.result)];
  }

  async function fillVia(id, value) {
    const frameId = frameOf(id);
    if (frameId === 0) return api.fill(id, value);
    const [res] = await chrome.runtime.sendMessage({ type: "frames-call", frameIds: [frameId], call: "fill", args: [id, value] });
    return !!res?.result;
  }

  async function collect() {
    if (scopeEl?.isConnected) {
      activeFrames = [0];
      return [{ frameId: 0, ...api.snapshot("", scopeEl) }];
    }
    const res = await chrome.runtime.sendMessage({ type: "collect" }).catch(() => null);
    let parts = res?.ok && res.parts.length ? res.parts : [{ frameId: 0, ...api.snapshot("") }];
    // On MyLab, only the question panel matters; drop the player chrome in other frames.
    if (parts.some((p) => p.mylab)) parts = parts.filter((p) => p.mylab);
    activeFrames = parts.map((p) => p.frameId);
    return parts.filter((p) => p.text);
  }

  // --- Solving ---
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  async function captureScreenshot() {
    if (scopeEl) scopeEl.scrollIntoView({ block: "center" });
    host.style.visibility = "hidden";
    await nextFrame();
    try {
      const res = await chrome.runtime.sendMessage({ type: "capture" });
      return res?.ok ? res.dataUrl : null;
    } finally {
      host.style.visibility = "";
    }
  }

  async function solve() {
    if (busy) return;
    setBusy(true);
    resultsEl.replaceChildren();
    footer.classList.remove("on");
    try {
      await callFrames("clearQuestions");
      setStatus("Reading the page…");
      const parts = await collect();
      lastSnapshot = parts.map((p) => (p.frameId === 0 ? p.text : `--- frame ---\n${p.text}`)).join("\n\n");
      const nFields = parts.reduce((s, p) => s + (p.fields || 0), 0);
      const nMath = parts.reduce((s, p) => s + (p.math || 0), 0);
      const mylab = parts.some((p) => p.mylab);

      const screenshot = prefs.includeScreenshot ? await captureScreenshot() : null;
      if (!lastSnapshot && !screenshot) {
        setStatus("Couldn't read anything on this page.", "error");
        return;
      }

      await callFrames("markFound");
      const found = [nMath && `${nMath} equation${nMath === 1 ? "" : "s"}`, nFields && `${nFields} answer field${nFields === 1 ? "" : "s"}`]
        .filter(Boolean).join(", ");
      setStatus(`Solving${mylab ? " MyLab question" : ""}${found ? ` · found ${found}` : ""}…`);
      const res = await chrome.runtime.sendMessage({
        type: "solve", snapshot: lastSnapshot, screenshot, url: location.href, title: document.title, mylab,
      });
      await callFrames("clearFound");

      if (!res?.ok) {
        const action = res?.code === "NO_KEY"
          ? { label: "Open settings", run: () => showSettings(true) }
          : { label: "Retry", run: solve };
        setStatus(res?.error || "Something went wrong.", "error", action);
        return;
      }

      footer.textContent = `Solved with ${res.result.model} · check answers before you submit`;
      for (const [label, run] of [["Clear highlights", () => callFrames("clearQuestions")], [copyAction.label, copyAction.run]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.addEventListener("click", run);
        footer.append(b);
      }
      footer.classList.add("on");

      const problems = res.result.problems || [];
      if (!problems.length) {
        const frames = parts.length > 1 ? ` across ${parts.length} frames` : "";
        setStatus(`No questions found (read ${lastSnapshot.length} characters${frames}, ${nFields} answer fields).`, "error", copyAction);
        return;
      }
      await renderResults(problems);
    } catch (e) {
      setStatus(String(e.message || e), "error", { label: "Retry", run: solve });
    } finally {
      callFrames("clearFound").catch(() => {});
      setBusy(false);
    }
  }

  const cards = new Map(); // problem number -> card

  function showCard(n) {
    const card = cards.get(n);
    if (!card) return;
    togglePanel(true);
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card.classList.remove("pulse");
    void card.offsetWidth;
    card.classList.add("pulse");
  }

  async function renderResults(problems) {
    cards.clear();
    await callFrames("markQuestions", problems.map((p, i) => ({ n: i + 1, refs: p.question_refs })));

    let filled = 0;
    for (const [i, p] of problems.entries()) {
      const n = i + 1;
      const card = document.createElement("div");
      card.className = "card";
      cards.set(n, card);

      const head = document.createElement("div");
      head.className = "q-head";
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = n;
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = p.question;
      head.append(num, q);

      const row = document.createElement("div");
      row.className = "a-row";
      const a = document.createElement("div");
      a.className = "a";
      a.textContent = p.answer;
      const btn = document.createElement("button");
      btn.className = "fill";

      // Fills run in order: a multiple-choice pick first, then the blanks it unlocks.
      const fills = p.fills || [];
      const ids = fills.map((f) => String(f.id));
      const doFill = async () => {
        btn.textContent = "Filling…";
        let ok = 0;
        for (const f of fills) if (await fillVia(String(f.id), f.value)) ok++;
        btn.textContent = ok === fills.length ? "Filled ✓" : ok ? `Filled ${ok}/${fills.length}` : "Couldn't fill";
        btn.className = ok === fills.length ? "fill done" : ok ? "fill part" : "fill none";
        return ok;
      };

      if (!fills.length) {
        btn.textContent = "No field";
        btn.className = "fill none";
      } else {
        btn.textContent = fills.length > 1 ? `Fill ${fills.length}` : "Fill";
        btn.addEventListener("click", () => btn.classList.contains("done") || doFill());
      }
      row.append(a, btn);

      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "Show steps";
      const steps = document.createElement("p");
      steps.textContent = p.steps;
      det.append(sum, steps);

      card.append(head, row, det);

      // Hovering a card lights up its question and outlines its fields, in whichever frame they are.
      card.addEventListener("mouseenter", () => callFrames("hover", n, ids, true));
      card.addEventListener("mouseleave", () => callFrames("hover", n, ids, false));
      card.addEventListener("click", (e) => {
        if (e.target === btn || e.target.closest("details")) return;
        callFrames("scrollTo", n, ids[0]);
      });

      resultsEl.append(card);
      if (prefs.autoFill && fills.length && (await doFill())) filled++;
    }

    const count = `${problems.length} problem${problems.length === 1 ? "" : "s"} solved`;
    setStatus(prefs.autoFill && filled ? `${count} · ${filled} filled in` : count, "done");
  }

  $(".solve").addEventListener("click", solve);

  // --- Shortcuts, hiding, opacity ---
  const toastEl = $(".toast");
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), 1200);
  }

  function applyHostLook() {
    host.style.opacity = look.opacity;
    host.style.display = look.hidden ? "none" : "";
  }

  function hotkey(action) {
    if (action === "solve") {
      solve(); // works while hidden too
    } else if (action === "hide") {
      chrome.storage.sync.set({ hidden: !look.hidden });
    } else if (action === "opacityUp" || action === "opacityDown") {
      const step = action === "opacityUp" ? 0.1 : -0.1;
      const opacity = Math.min(1, Math.max(0.1, Math.round((look.opacity + step) * 10) / 10));
      chrome.storage.sync.set({ opacity });
      if (!look.hidden) toast(`Opacity ${Math.round(opacity * 100)}%`);
    }
  }

  // Shortcut hints on the buttons.
  function applyKeyHints() {
    $(".solve").title = keybinds.solve ? `Solve (${keybinds.solve})` : "Solve";
  }
  chrome.storage.onChanged.addListener((changes, area) => area === "sync" && changes.keybinds && applyKeyHints());

  const ui = { togglePanel, showCard, hotkey, applyLook: () => { applyHostLook(); applyKeyHints(); matchBackground(); } };

  chrome.storage.sync.get(PREFS).then((p) => {
    prefs = { ...PREFS, ...p };
    mount();
    applyPrefs();
  });
})();
