---
name: google-sheets
description: >
  Operate Google Sheets (sheets.new or existing spreadsheets) through the
  browser arm tools: navigate cells, type text/numbers, enter formulas,
  switch sheet tabs, use ranges, undo, and verify results. Use when asked to
  create or fill a spreadsheet, or work inside sheets.google.com /
  docs.google.com/spreadsheets.
---

# Driving Google Sheets with the browser arm

The grid is canvas-rendered — cells are NOT DOM elements. You cannot click or
read cells directly. You drive Sheets through two real UI surfaces: the **Name
Box** (cell/range selector) and the transient **cell editor**.

## Core recipe (verified end-to-end)

1. `browser_navigate` to `https://sheets.new` (new spreadsheet, needs an
   already-logged-in Google session) or the spreadsheet URL.
2. `browser_snapshot`. The Name Box is the `<input type=text>` line showing the
   current cell (class `waffle-name-box`) — note its id.
3. **Select a cell**: `browser_type(nameBoxId, "C4", submit=true)`.
4. **Enter edit mode**: `browser_press("Enter")`. This summons the editor: a
   focused contenteditable `<div class="cell-input editable">`. It does NOT
   exist in the DOM before this step.
5. **Get the editor's id** (first time per page only): the editor matches the
   snapshot's `[contenteditable]` selector, but so do other divs. Disambiguate:
   - `browser_evaluate`: set `document.querySelector('.cell-input.editable').textContent = 'ZZMARKER'`
   - `browser_snapshot` → the line `<div> ZZMARKER` is the editor's id
   - `browser_evaluate`: clear `textContent = ''`
6. **Type the value**: `browser_type(editorId, "Widgets", submit=true)`.
   Real IME insertion + Enter commits and moves selection DOWN one (like a
   human). The editor element is reused across cells — its stamped id survives
   commits, so steps 3–6 repeat without another marker/snapshot:
   Name Box navigate (or rely on auto move-down) → `press Enter` → `type`.

Formulas are typed as plain text: `=SUM(C2:C3)`, `=AVERAGE(B2:B10)` — same
recipe, Sheets evaluates on commit. Verify computed results via screenshot
(the grid is canvas — `browser_evaluate` cannot read cell values).

## Cookbook

- **Sheet tabs** (switch/add): the bottom bar appears in snapshots as
  `<div> Sheet1`, `<div> Add Sheet`, `<div> All Sheets`. Switch tab =
  `browser_click` that tab's id; new tab = click `Add Sheet`. Verified.
  ⚠ adding a sheet re-renders the tab strip — arm ids on tabs die; snapshot
  again before clicking a tab.
- **Ranges** (verified): the Name Box accepts ranges — type `A1:B1` + Enter,
  then click toolbar buttons from the snapshot (e.g. `<div> Bold (⌘B)`)
  applied bold across the whole range. There are NO modifier keys in the arm
  (`press` has no Ctrl/⌘), so prefer toolbar buttons over keyboard shortcuts.
- **Clear a cell** (verified): select via Name Box → `browser_press("Delete")`
  (also `Backspace`).
- **Undo/Redo** (verified): click the snapshot's `<div> Undo (⌘Z)` /
  `<div> Redo (⌘Y)` toolbar buttons — don't try Ctrl+Z (no modifiers).
- **Rename/duplicate/delete a sheet**: needs right-click or double-click on
  the tab, which the arm can't do. Use the `All Sheets` button's dropdown
  instead: click it, snapshot the revealed menu items, click the action.
- **Menus (File/Edit/Data/Insert…)**: menu-bar items don't appear in
  snapshots. General stamp trick: `browser_evaluate` to find the element by
  text and mark it, then snapshot to get its id, then `browser_click`:
  ```js
  [...document.querySelectorAll('div,span')].filter(e => e.childElementCount === 0 && e.innerText.trim() === 'Data').at(-1).setAttribute('data-arm-id', 'menu')  // then snapshot & find
  ```
  ⚠ the id you type into `data-arm-id` must use the agent prefix; simplest is
  to overwrite the textContent with a `ZZMARKER` and read the stamped id from
  the snapshot instead (see step 5).
- **Most-used formulas** (all just text through the editor): `SUM`,
  `AVERAGE`, `MIN`/`MAX`, `COUNT`/`COUNTA`, `IF`, `SUMIF`/`COUNTIF`,
  `XLOOKUP`/`VLOOKUP`, `INDEX`/`MATCH`, `CONCATENATE`/`&`, `TODAY()`/`NOW()`,
  `ROUND`, `UNIQUE`, `SORT`/`FILTER`, `QUERY`.
- **Autocomplete** (verified): typing a formula pops Sheets' suggestion
  dropdown — it's real DOM (`[role=listbox]`, visible mid-typing). Typing the
  FULL formula then Enter commits it correctly (e.g. `=AVERAGE(B2:B3)` → 21,
  no suggestion corruption).

## Traps (each one cost a failed attempt)

- The `<textarea>` with an empty label in snapshots is `trix-offscreen`, a
  hidden clipboard helper. Typing there goes into a void — tool reports
  success, zero effect. The real formula bar doesn't exist in the DOM until a
  cell is in edit mode.
- Don't try to `browser_type` into the grid — there is no element. Keyboard
  entry must be real key events (`browser_press`), not evaluate-synthesized.
- arm ids restamp on every `browser_snapshot` and die on navigation. After
  `browser_navigate`, snapshot again before using any id. DOM mutations from
  clicks (e.g. adding a sheet tab, opening menus) can also invalidate stamps
  in that region — if you get "element #N gone", just re-snapshot.
- If tools suddenly report "not connected": the arm self-heals (WS pings keep
  the service worker alive; a `chrome.alarms` keepalive reconnects it within
  ~30s if Chrome killed it anyway). Reload the extension only to deploy
  updated background.js code — never for connectivity.

## Auth

`sheets.new` requires a Google session. If navigation lands on a login page,
stop and ask the user to sign in — never attempt credentials.
