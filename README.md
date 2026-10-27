# Hydramath

<img src="extension/icons/icon128.png" width="64" alt="">

Developed by Logic.

A Chrome extension that solves Pearson MyLab questions with Claude and fills in the answer fields.

It runs only in tabs showing `https://mylab.pearson.com`, including the question frames inside those pages (which may come from other Pearson domains). On every other site it stops immediately: no button, no shortcuts, no page access, and the toolbar icon is greyed out. The allowed address is `ALLOWED_TOP` in `content.js` and `MYLAB_HOST` in `background.js`.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. Open the panel (the Hydramath button or Alt+M), click **⚙**, and paste your Anthropic API key.

Settings live inside the panel (⚙ to open, ‹ to go back) and save as you change them. They're stored in Chrome sync, including the API key, so they follow you to any Chrome signed into the same account. The settings view is an extension frame, so the website can't see what you type into it. The same page is also under **Details → Extension options**.

## Use

- Click the floating Hydramath button (drag it anywhere), the toolbar icon, or press **Alt+M**.
- **Solve this page** reads every problem and answer field on the page.
- **Pick** lets you click one question to solve only that part.
- Each answer gets a card with the result, the steps, and a **Fill** button. With *Fill answers automatically* on, fields are filled as soon as the answers arrive.
- Turn on *Include a screenshot* for math drawn as images.
- While solving, the equations it found get a dashed outline. Afterwards each question is tinted; hover an answer card to light up its question and answer box, or click the card to scroll to it. Turn **Show highlights** off (panel or settings) to remove every outline and tint from the page.
- Math editors that ignore script-made key presses (e.g. Pearson/Savvas equation boxes) are typed into with real keystrokes through Chrome's debugger API. Chrome briefly shows a "started debugging this browser" bar while it types.

## Shortcuts

Set these under **Settings → Keyboard shortcuts** (click a shortcut, press the new keys; Backspace clears it). They work even when the cursor is inside a question iframe.

| Action | Default |
| --- | --- |
| Auto solve (works while hidden) | Alt+S |
| Hide / show everything (button, panel, outlines) | Alt+H |
| Opacity up / down (10% steps) | Alt+= / Alt+- |
| Open / close the panel | Alt+M (set in Chrome's shortcut settings) |

Hidden and opacity are remembered across pages; the Visibility section in settings can change them too.

**Match page background** (on by default, switch in the panel or settings): the panel and button take the colour of whatever is behind them, including inside same-origin question iframes, with text and buttons tinted to match. It re-checks when the panel opens, the button is dragged, and on scroll/resize. Behind a cross-origin iframe it assumes white.

## MyLab mode

On Pearson MyLab (detected by its `xl.player.ContentPanel` question panel), the extension:

- reads only the question panel (no player navigation, score, or buttons) and drops screen-reader-only headings;
- keeps MyLab's own ids: answer boxes as `S1`, `S2` (with their lead-in text, e.g. "The sum of the series is"), and each multiple-choice question as one lettered list `[[CHOICES id=M1 pick=one|many]] A) … B) …`;
- adds MyLab-specific instructions (answer every unanswered part, exact simplified answers, letter-only choice answers);
- fills by id: `M1 = "A"` clicks option A (a multi-letter answer to a pick-one question is rejected), `S1 = "16"` types into box S1.

Other sites use the general reader. `test/mylab.html` is a two-part MyLab copy for testing.

## How it works

- `content.js` turns the page into reading-order text: MathML, KaTeX, MathJax 2/3 and image alt text become LaTeX, and each answer field becomes a marker like `[[INPUT id=3 type=text]]`. Text inputs, textareas, dropdowns, radio/checkbox groups, contenteditable fields, and MathQuill fields are supported.
- `background.js` sends that text (plus an optional screenshot) to the Claude API with a JSON schema, and gets back each problem's answer and the field ids to fill.
- Answers are written with the native value setter and `input`/`change` events, so React/Vue forms pick them up.

## Limits

- Canvas-drawn questions need the screenshot option.
- Custom dropdown menus that only build their options when opened aren't supported yet (native `<select>` is).
- If it misses something, use **Copy page text** in the panel to see exactly what it read.

Every frame runs the content script, so questions inside iframes (including other domains, as in Pearson/Savvas players) are read, filled, and highlighted. Multiple choice works with native radios/checkboxes and ARIA options (`role="radio"`, `"checkbox"`, `"option"`); the chosen option is clicked first, then any answer boxes inside it are filled.

## Testing

`test/test.html` loads `content.js` with a mocked `chrome` API. Serve the project folder (e.g. `python -m http.server 8765`) and open `http://localhost:8765/test/test.html`.
