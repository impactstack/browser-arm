# Browser Arm

Give any AI coding agent an arm to drive Chrome.

```
┌──────────────┐  tool calls   ┌────────────────┐  ws://localhost:8765  ┌────────────────────┐
│  LLM in pi   ├──────────────►│  pi extension  ├──────────────────────►│  Chrome extension  │
│  (you chat)  │◄──────────────┤  (ws server)   │◄──────────────────────┤  (chrome.debugger) │
└──────────────┘   results     └────────────────┘                       └────────────────────┘
```

- **pi side** (`pi-extension/`): registers 10 `browser_*` tools + `/arm` status command. Hosts a WebSocket server; extra pi sessions auto-relay through it.
- **Chrome side** (`chrome-extension/`): MV3 service worker that dials the server and executes commands via `chrome.debugger` (CDP) — real input events, screenshots, JS evaluation.
- **Agent-agnostic**: pi is just the shipped adapter. The arm speaks a tiny JSON-over-WebSocket protocol — any agent or script that can open a WebSocket (Claude Code, Cursor, your own code) can drive it. See [Using with any agent](#using-with-any-agent-protocol).

## Layout

```
chrome-extension/   MV3 extension (background.js + manifest) — the actual arm
pi-extension/       pi agent extension (TypeScript, ws server) — the brain's hand
skills/             pi skills that ride on the arm (google-sheets)
fake-arm.js         headless stand-in for Chrome, for testing the pi side
selfcheck.mjs       end-to-end self-check (host + relay), no Chrome needed
make-icons.mjs      regenerates chrome-extension/icons (stdlib-only PNG writer)
```

## Install

> **For AI agents executing this README:** run each command verbatim from the repo root, check the ✅ Verify line before moving on, and stop at the first failure. Replace `<ABS>` with the repo's absolute path (macOS/Linux: `$(pwd)` after cloning; Windows: the cloned folder, e.g. `C:\src\browser-arm` — in JSON, backslashes must be escaped as `\\`).

### Step 1 — Node.js 18+ and dependencies

macOS / Linux:

```bash
node --version || brew install node
cd <ABS>/pi-extension && npm install && cd ..
```

Windows (PowerShell):

```powershell
node --version; if ($LASTEXITCODE -ne 0) { winget install OpenJS.NodeJS.LTS }
cd <ABS>\pi-extension; npm install; cd ..
```

✅ Verify: `node --version` prints v18+ and this prints `ws ok`:

```bash
node -e "require('ws'); console.log('ws ok')"   # run from <ABS>/pi-extension
```

### Step 2 — Register the extension with pi

Edit pi's settings file (create if missing; merge keys if it exists — don't overwrite other settings):

| OS | File |
|----|------|
| macOS / Linux | `~/.pi/agent/settings.json` |
| Windows | `%USERPROFILE%\.pi\agent\settings.json` |

```json
{
  "extensions": ["<ABS>/pi-extension"]
}
```

macOS / Linux example: `"/Users/me/src/browser-arm/pi-extension"` · Windows example: `"C:\\src\\browser-arm\\pi-extension"`

✅ Verify (macOS / Linux):

```bash
node -e "const s=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.pi/agent/settings.json')); console.log(s.extensions.find(e=>e.endsWith('pi-extension')) ? 'registered' : 'MISSING')"
```

Windows (PowerShell):

```powershell
node -e "const s=JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.pi/agent/settings.json')); console.log(s.extensions.find(e=>e.endsWith('pi-extension')) ? 'registered' : 'MISSING')"
```

Then **restart pi** — extensions load at startup. Check with `/arm` in pi: it should say `hosting ws://localhost:8765, waiting for Chrome` (or `Chrome connected`).

### Step 3 — Load the Chrome extension (manual UI step, both OSes)

An agent can guide the user through this; it cannot click it itself:

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** → select the folder `<ABS>/chrome-extension`
4. The "Browser Arm started debugging this browser" infobar is expected

✅ Verify: within ~2s, the pi session's `/arm` says `Chrome connected` (the extension dials every 2s).

### Step 4 — End-to-end check (works without pi, too)

With Chrome loaded, drive the arm directly over the protocol:

```bash
node --input-type=module -e "
const arm = new WebSocket('ws://localhost:8765');
await new Promise((r) => (arm.onopen = r));
arm.onmessage = (e) => { const m = JSON.parse(e.data); console.log(m.ok ? 'OK: ' + m.result : 'FAIL: ' + m.error); process.exit(m.ok ? 0 : 1); };
arm.send(JSON.stringify({ id: 1, cmd: 'navigate', params: { url: 'https://example.com' }, agent: 'install-check' }));
"
```

✅ Verify: prints `OK: Loaded: Example Domain — https://example.com/`. (This opens a dedicated window for the `install-check` agent; it auto-closes after 10 min idle.)

Exit codes: 0 = installed and working. Any FAIL means the Chrome extension isn't loaded (Step 3) or the port is busy — override with `BROWSER_ARM_PORT` on the pi side and `PORT` in `chrome-extension/background.js`.

No-Chrome fallback: `node fake-arm.js` stands in for the browser (canned responses — proves the pi-side loop only).

### Alternative: symlink instead of settings.json

macOS / Linux:

```bash
mkdir -p ~/.pi/agent/extensions && ln -s <ABS>/pi-extension ~/.pi/agent/extensions/browser-arm
```

Windows: symlinks need Developer Mode (Settings → Privacy & security → For developers); prefer the settings.json route.

## Tools

| Tool | What it does |
|------|--------------|
| `browser_navigate` | Open a URL in the agent's own window (`newTab: true` → fresh tab in that window), waits for load |
| `browser_snapshot` | Numbered outline of interactive elements (`12: <button> Sign in`) |
| `browser_click` | Real mouse click on `#id` from the last snapshot |
| `browser_type` | Click + type text into `#id`, optional Enter (`submit`); `mode: "chars"` for keydown-listener inputs |
| `browser_press` | Special key in the focused element: Enter, Tab, Backspace, Delete, Escape, arrows |
| `browser_read` | Page's visible text (≤20k chars) |
| `browser_screenshot` | Viewport jpeg returned as an image for the model |
| `browser_evaluate` | Arbitrary JS in the page (escape hatch) |
| `browser_tabs` | list (all tabs, with owning agent) / select (adopt any tab) / close |
| `browser_profile` | list / select which Chrome profile (person) this session drives — only matters when 2+ profiles have the arm loaded |

Typical agent loop: `snapshot` → `click`/`type` by id → `screenshot` or `read` to verify.

## Using with any agent (protocol)

The pi extension is optional plumbing — the arm itself only needs a WebSocket client. Connect to `ws://localhost:8765` (any path except `/chrome`, which is reserved for the Chrome extension) and exchange JSON:

```jsonc
// request  — agent id gives the caller its own dedicated browser window
{ "id": 1, "cmd": "navigate", "params": { "url": "https://example.com" }, "agent": "my-agent" }
// response
{ "id": 1, "ok": true, "result": "Loaded: Example Domain — https://example.com/" }
// on failure: { "id": 1, "ok": false, "error": "..." }
```

Commands (`params`):

| cmd | params | returns |
|-----|--------|---------|
| `navigate` | `{ url, newTab? }` | status line, waits for load |
| `snapshot` | `{}` | numbered interactive elements |
| `click` | `{ id }` | confirmation |
| `type` | `{ id, text, submit?, mode? }` | confirmation |
| `press` | `{ key }` | confirmation |
| `read` | `{}` | page text (≤20k chars) |
| `screenshot` | `{}` | `{ data }` base64 jpeg |
| `evaluate` | `{ expression }` | JSON value |
| `tabs` | `{ action: "list"\|"select"\|"close", tabId? }` | list / confirmation |

Minimal client — works from any language with a WebSocket lib. Node 22+ example (zero deps):

```js
// arm-client.mjs
const arm = new WebSocket("ws://localhost:8765");
await new Promise((r) => (arm.onopen = r));
let id = 0;
const pending = new Map();
arm.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const call = (cmd, params = {}, agent = "my-agent") =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    arm.send(JSON.stringify({ id, cmd, params, agent }));
  });

console.log(await call("navigate", { url: "https://example.com" }));
console.log(await call("snapshot"));
```

Same `agent` id ⇒ same dedicated window + element-id namespace; a different id spawns a separate window. Per-agent commands are serialized, so concurrent agents can't interleave half a click.

## Security

The WebSocket server binds to **localhost with no auth**. Anything running on your machine can connect to `ws://localhost:8765` and drive your browser — with your logged-in sessions (read pages, screenshots, run JS). A hostile public website cannot reach it (Chrome blocks public → localhost), but any local process can. Practical posture:

- Load the extension only while you're using the arm; unload it otherwise.
- Don't run untrusted local code with the arm connected.
- The agent sees and can act on whatever your browser is logged into — same trust level as you at the keyboard.

## Skills

`skills/google-sheets` teaches the agent to drive Google Sheets through the arm (the grid is canvas — it must go via the Name Box and cell editor). `skills/browser-arm` is the base skill: window lifecycle (closes when a run settles), snapshot id hygiene, waiting, and error recovery. `skills/ui-testing` teaches it to test web app UIs like a test engineer: derive happy/bad/edge scenarios, click through flows, assert on DOM state, wait for async updates, capture console errors, report a pass/fail table. `skills/perf-audit` teaches it to audit loading performance: in-page Core Web Vitals (TTFB/FCP/LCP/CLS/TBT) via `browser_evaluate`, full Lighthouse via `npx`, and a finding→fix map. Install like any pi skill: symlink into `~/.pi/agent/skills/`.

## Testing

```bash
npm test          # selfcheck: real ws server + fake-arm + second-session relay probe
node fake-arm.js  # manual: canned arm without Chrome
```

Tests run on port 8799 so they never touch a live arm session.

## Notes & troubleshooting

- Chrome shows a **"Browser Arm started debugging this browser"** infobar — that's `chrome.debugger`, expected.
- `chrome://` and Web Store pages reject debugger attach; use normal pages.
- Multiple pi sessions share one arm: the first session hosts, the rest auto-relay through it (and take over hosting if the host exits).
- Multiple Chrome profiles: Chrome installs extensions per profile, so load the extension in each profile you want drivable. Every profile registers with a stable id (its own cookies/logins stay separate); with 2+ connected, pick with `browser_profile select` — with exactly one, everything routes there automatically. Agent windows are per (profile, session) and never collide.
- Port is 8765; override on both sides with `BROWSER_ARM_PORT` (env for pi, edit `PORT` in `background.js` for Chrome).
- Multiple agents, no collisions: every session stamps commands with an agent id — each agent gets **its own window** and its own element-id namespace, and per-agent commands are serialized so half-clicks/half-typed strings can't interleave. `browser_tabs list` shows which agent owns which tab.
- Memory: an agent's window auto-closes after **10 min of inactivity** (via `chrome.alarms`, so it works even when the service worker sleeps) — and only windows the arm itself created; user windows adopted via `tabs select` are never closed.
- Icons are generated by `node make-icons.mjs` (stdlib-only PNG writer, no image deps).
- Extension disconnected? The service worker reconnects every 2s; check `chrome://extensions` → Browser Arm → service worker console.
- Snapshot ids go stale after navigation — agents should re-snapshot.
