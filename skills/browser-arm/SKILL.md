---
name: browser-arm
description: >
  Use the browser_* tools well: window lifecycle (it closes when your run
  settles), snapshot id hygiene, waiting, error recovery, and evidence
  gathering. Use for ANY browser task that isn't covered by the specialized
  skills (google-sheets, ui-testing, perf-audit) — browsing, scraping a page,
  filling a form, checking something visually.
---

# Using the Browser Arm

## Caution: the window closes when your run settles

The arm window exists only while you are actively working. The moment your
run settles, it closes — page state (logins, forms, scroll, SPA route) is NOT
kept. Therefore:

- **Prepare before the first browser command**: know the URL, what you'll
  check, and what "done" looks like. Reachability pre-flight for local apps:
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT`.
- **Batch browser steps into one run.** Don't reply to the user, run long
  shell jobs, or wait for input between browser steps — that settles the run
  and wipes the page.
- **Login + task together**: anything needing an authenticated page must do
  the login in the same run.
- **After a settle, expect a fresh page**: re-navigate (and re-login) before
  continuing. Never assume the page you left is still there.
- The window respawns automatically on the next browser command — closing is
  cleanup, not breakage.

## Core etiquette

1. `browser_navigate` → `browser_snapshot` → act by id (`browser_click` /
   `browser_type` / `browser_press`).
2. **Re-snapshot before every interaction round.** Ids go stale after ANY
   navigation or DOM change — the #1 mistake.
3. Verify with `browser_read` (prose), `browser_evaluate` (structured state),
   or `browser_screenshot` (what the user would see).
4. One check per `browser_evaluate`; top-level `await` is a SyntaxError —
   wrap awaited code in `(async () => { ... })()`.
5. Poll instead of guessing: `(async () => await new Promise((r) => { const t =
   setInterval(() => document.querySelector(".done") && (clearInterval(t), r(true)), 100);
   setTimeout(() => { clearInterval(t); r(false); }, 5000); }))()`.

## Recovery

- Landed on `chrome://newtab` (or the user hit ctrl+T in the window)? It
  auto-recovers to about:blank — just navigate.
- `chrome://settings`, other extensions' pages, etc. refuse the debugger with
  a clear error — `browser_navigate` away or `browser_tabs select` an http
  tab.
- Element "gone — run browser_snapshot again" → the DOM moved; re-snapshot.
- "arm timed out" / disconnected → check the host pi session with `/arm`;
  Chrome reconnects by itself every 2s.
