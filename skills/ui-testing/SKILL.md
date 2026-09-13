---
name: ui-testing
description: >
  Test a web app's UI through the browser arm tools: click through flows, fill
  forms, assert on DOM state and visible text, wait for async updates, capture
  console errors, and screenshot evidence. Use when asked to test, verify,
  smoke-test, or debug the UI of a web page or app (local dev server or
  deployed URL).
---

# Testing web UIs with the browser arm

## Test design (do this before clicking anything)

Act like a test engineer: read the feature, then derive a scenario list
before touching the browser. Standard coverage:

1. **Happy path** — the intended flow end to end with valid data.
2. **Bad paths** — required fields empty, invalid formats (`not-an-email`),
   wrong types, expired/absent auth, backend error states.
3. **Edge cases** — empty string vs whitespace-only, max-length and
   over-max-length values, special chars (`<script>`, emoji, RTL text),
   double-submit (click the button twice fast — is anything duplicated?),
   refresh mid-flow, browser back (`browser_evaluate`: `history.back()`),
   deep-linking straight to a later step's URL, and rerunning the flow twice
   (idempotency).

Fake a backend failure without touching the backend — intercept before acting:

```js
(() => { const f = window.fetch; window.fetch = (...a) => Promise.reject(new Error("simulated outage")); return "fetch will now fail"; })()
```

(Re-navigate to undo it.) Execute each scenario through the core loop below,
then report a table: `scenario | expected | actual | pass/fail` + screenshots
for failures. Order matters — run happy path first, edge cases after, and
re-navigate between scenarios to reset app state.

## Core loop

1. `browser_navigate` to the app (`http://localhost:3000` etc. — local dev
   servers work like any URL). Full reload = clean app state.
2. `browser_snapshot` → note element ids.
3. Act: `browser_click` / `browser_type` / `browser_press`.
4. **Re-snapshot before the next interaction.** Ids go stale after ANY
   navigation or DOM change — this is the #1 mistake.
5. Assert (below).
6. `browser_screenshot` as evidence for the user.

## Waiting for async UI

There is no wait tool. Poll with `browser_evaluate` — but top-level `await`
is a SyntaxError there, so wrap awaited code in an async IIFE:

- Wait for a selector (5s timeout, returns `true`/`false`):

  ```js
  (async () => await new Promise((r) => {
    const t = setInterval(() => document.querySelector(".result") && (clearInterval(t), r(true)), 100);
    setTimeout(() => { clearInterval(t); r(false); }, 5000);
  }))()
  ```

- Wait for text: same shape with `document.body.innerText.includes("Saved")`.
- Fixed settle: `(async () => { await new Promise((r) => setTimeout(r, 800)); return "settled"; })()`

## Assertions

Keep one assertion per `browser_evaluate` — failures stay readable. Return a
value and compare it yourself:

- Visible text: `document.body.innerText.includes("Order confirmed")`
- Input state: `document.querySelector("#email")?.value` or `...?.validity.valid`
- Computed style / visibility: `getComputedStyle(document.querySelector("#x")).display !== "none"`
- SPA route (no reload happens): `location.pathname`
- Element count: `document.querySelectorAll(".cart-item").length`

`browser_read` is for prose-level checks (does the page say X), not precise
state — prefer `evaluate` for anything structured.

## Console & page errors

Install a hook right after load, act, then read it. The hook survives SPA
updates but dies on full reload — reinstall after every `browser_navigate`:

```js
window.__errs ??= [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason)));
```

Then `window.__errs` — expect `[]`. Empty it between steps with `window.__errs = []`.

## Form flow recipe

1. `browser_snapshot` — find inputs by their label/placeholder text in the lines.
2. `browser_type` into each field (`submit` only on the last one, or plain
   type + `browser_click` the submit button).
3. Wait (selector/text from "Waiting"), assert success text or URL change.
4. `browser_screenshot` the result. On failure: `browser_read` the page and
   `window.__errs` before concluding anything.

## Gotchas

- Snapshot ids are per-snapshot, namespaced to your agent session — never reuse
  ids from an earlier snapshot.
- Canvas/WebGL content has no DOM to inspect (charts, grids) — assert via
  `browser_screenshot` instead.
- Modals, toasts, dropdowns are real DOM — they show up in snapshots
  (`[role=button]`, `[role=dialog]` children, etc.).
- `browser_evaluate` sees what the page sees, nothing more (no network panel,
storage of other tabs). Top-level `await` fails — always wrap in
`(async () => { ... })()`.
- Testing as a different user / role? Incognito isn't available — use the
  app's own logout/login flow, or a second agent session only if you want a
  parallel browser context (same Chrome profile, so same cookies).
