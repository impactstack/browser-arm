# Browser Arm

Give any AI coding agent an arm to drive Chrome.

```
┌──────────────┐  tool calls   ┌────────────────┐  ws://localhost:8765  ┌────────────────────┐
│  LLM in pi   ├──────────────►│  pi extension  ├──────────────────────►│  Chrome extension  │
│  (you chat)  │◄──────────────┤  (ws server)   │◄──────────────────────┤  (chrome.debugger) │
└──────────────┘   results     └────────────────┘                       └────────────────────┘
```

- **pi side** (`pi-extension/`): registers 9 `browser_*` tools + `/arm` status command. Hosts a WebSocket server; extra pi sessions auto-relay through it.
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

## Setup

Prerequisite: [Node.js](https://nodejs.org) 18+.

- **macOS**: `brew install node` (or the installer from nodejs.org)
- **Windows**: `winget install OpenJS.NodeJS.LTS` (or the installer from nodejs.org)

**1. Get the repo and install the one dependency (`ws`):**

macOS / Linux (Terminal):

```bash
git clone https://github.com/impactstack/browser-arm.git
cd browser-arm/pi-extension && npm install
```

Windows (PowerShell):

```powershell
git clone https://github.com/impactstack/browser-arm.git
cd browser-arm\pi-extension; npm install
```

**2. Register the extension with pi** — add its absolute path to `settings.json`:

| OS | File |
|----|------|
| macOS / Linux | `~/.pi/agent/settings.json` |
| Windows | `%USERPROFILE%\.pi\agent\settings.json` (i.e. `C:\Users\<you>\.pi\agent\settings.json`) |

```json
{
  "extensions": ["/absolute/path/to/browser-arm/pi-extension"]
}
```

Example paths:

- macOS: `/Users/you/browser-arm/pi-extension`
- Windows: `C:\\Users\\you\\browser-arm\\pi-extension` (backslashes must be escaped as `\\` in JSON)

(Alternatively copy/symlink into `~/.pi/agent/extensions/browser-arm` — on Windows, symlinks require Developer Mode: Settings → Privacy & security → For developers → enable it.)

**3. Chrome extension** (same on both OSes): open `chrome://extensions` → enable **Developer mode** (top right) → **Load unpacked** → select the `chrome-extension/` folder from the repo.

**4. Verify**: run `pi`, type `/arm`. Should say connected. Without Chrome, `node fake-arm.js` stands in for the browser (every command gets a canned response — proves the loop works).

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

`skills/google-sheets` teaches the agent to drive Google Sheets through the arm (the grid is canvas — it must go via the Name Box and cell editor). Install like any pi skill: symlink into `~/.pi/agent/skills/`.

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
- Port is 8765; override on both sides with `BROWSER_ARM_PORT` (env for pi, edit `PORT` in `background.js` for Chrome).
- Multiple agents, no collisions: every session stamps commands with an agent id — each agent gets **its own window** and its own element-id namespace, and per-agent commands are serialized so half-clicks/half-typed strings can't interleave. `browser_tabs list` shows which agent owns which tab.
- Memory: an agent's window auto-closes after **10 min of inactivity** (via `chrome.alarms`, so it works even when the service worker sleeps) — and only windows the arm itself created; user windows adopted via `tabs select` are never closed.
- Icons are generated by `node make-icons.mjs` (stdlib-only PNG writer, no image deps).
- Extension disconnected? The service worker reconnects every 2s; check `chrome://extensions` → Browser Arm → service worker console.
- Snapshot ids go stale after navigation — agents should re-snapshot.
