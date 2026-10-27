// Keyboard shortcuts shared by the content script and the settings page.
globalThis.MA_KEYS = (() => {
  const ACTIONS = {
    solve: "Auto solve",
    hide: "Hide / show",
    opacityUp: "Opacity up",
    opacityDown: "Opacity down",
  };

  const DEFAULTS = { solve: "Alt+S", hide: "Alt+H", opacityUp: "Alt+=", opacityDown: "Alt+-" };

  // Physical keys, so Alt+S works the same on every keyboard layout (and on Mac, where
  // Option+S types "ß").
  const CODE_KEYS = {
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`", Space: "Space",
  };
  const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph"]);

  // "Ctrl+Alt+Shift+Meta+Key", or null while only modifiers are held.
  function comboOf(e) {
    if (MODIFIERS.has(e.key)) return null;
    let key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3)
      : /^Digit\d$/.test(e.code) ? e.code.slice(5)
      : CODE_KEYS[e.code] || e.key;
    if (key.length === 1) key = key.toUpperCase();
    return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", key].filter(Boolean).join("+");
  }

  // Shortcuts need a modifier so they never fire while typing an answer (F-keys excepted).
  const isUsable = (combo) => /^(Ctrl|Alt|Meta)\+/.test(combo) || /(^|\+)F\d{1,2}$/.test(combo);

  return { ACTIONS, DEFAULTS, comboOf, isUsable };
})();
