# PostMessage Scanner

A Chrome DevTools extension for static analysis of `postMessage` sinks and `message` event listeners in JavaScript loaded by any page.

---

## What it detects

| Finding | Description |
|---|---|
| `postMessage(*)` | Wildcard `targetOrigin` — message sent to any origin |
| `message-listener` | `addEventListener("message", ...)` with no or weak origin check |
| `weak-origin-check` | Origin validated with a spoofable method (`includes`, `startsWith`, etc.) |

---

## Install

1. Clone or download this repo
2. Run `mkdir libs && npm install` to pull acorn / babel dependencies into `node_modules`
3. Copy the required libs into `libs/`:
   ```
   libs/babel.min.js      ← node_modules/@babel/standalone/babel.min.js
   libs/acorn.js          ← node_modules/acorn/dist/acorn.js
   libs/acorn-loose.js    ← node_modules/acorn-loose/dist/acorn-loose.js
   ```
4. Open Chrome → `chrome://extensions` → enable **Developer mode**
5. Click **Load unpacked** → select this folder
6. Open DevTools on any page → go to the **PostMessage** tab

---

## Usage

The scanner starts automatically when you open the panel.

| Button | Action |
|---|---|
| Start Scan | Attach debugger and begin intercepting scripts |
| Stop Scan | Detach debugger, keep results visible |
| Clear Results | Wipe the findings table |
| Export JSON | Download all findings as a `.json` file |

Click **Log** on any row to send a clickable source link to the page console.

The scanner re-attaches automatically on page navigation — no need to click Start Scan again.

---

## How it works

Scripts are intercepted via the Chrome Debugger Protocol (`Debugger.scriptParsed`). Each script source is pulled with `Debugger.getScriptSource` and fed into a two-engine static analyser:

**Engine 1 — Babel traverse** (primary)
Full scope-aware AST traversal. Resolves:
- Multi-hop variable chains (`chain4 ← chain3 ← ... ← "*"`)
- Aliased references (`const pm = window.postMessage.bind(window)`)
- Computed property names (`window["post"+"Message"]`)
- IIFEs returning a wildcard (`(() => "\u002a")()`)
- Array/object literal indexing (`["safe","*"][1]`)
- Identity-wrapper laundering (`wrap(window.postMessage.bind(window))(data, "*")`)
- Indirect dispatch via `.call()`, `.apply()`, `Reflect.apply()`
- `String.fromCharCode(42)` and binary `+` concatenation

**Engine 2 — acorn-loose** (fallback if Babel fails to load)
Same pattern coverage using a flat forward-pass walker. Slightly less precise on deeply nested scopes but matches Babel output on all standard patterns.

---

## File structure

```
manifest.json
devtools.html / devtools.js   ← registers the DevTools panel
panel.html / panel.js         ← UI and scan orchestration
scanner.js                    ← static analyser (both engines)
libs/
  babel.min.js
  acorn.js
  acorn-loose.js
icons/
  icon16/32/48/128.png
```

---

## Permissions used

| Permission | Why |
|---|---|
| `debugger` | Intercept scripts via CDP |
| `activeTab` | Identify the inspected tab |
| `storage` | Reserved for future settings persistence |
| `host_permissions: <all_urls>` | Attach debugger to any domain |

---

## Limitations

- **Static analysis only** — dynamic `eval`-constructed scripts are flagged as unresolved and need manual review
- **One tab at a time** — the debugger session is per-tab; switching tabs requires reopening the panel
- **CSP-locked pages** — the Log button falls back to a `console.warn` if the page blocks `eval`
- **Minified code** — line numbers point to the minified output; source map resolution is attempted automatically when a `sourceMappingURL` header is present
