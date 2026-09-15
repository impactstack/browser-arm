// Browser Arm — pi side.
// Hosts a WebSocket server that the Browser Arm Chrome extension dials; relays
// tool commands to the browser and returns results (incl. screenshots) to the LLM.
// If another pi session already owns the port, this session becomes a relay
// client instead, so every session can drive the same arm.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.BROWSER_ARM_PORT) || 8765;
const TIMEOUT_MS = 20_000;
const AGENT_ID = randomBytes(4).toString("hex"); // stamps every command; the Chrome side keys tabs + element ids per agent

// ---------- bridge ----------

let wss: WebSocketServer | null = null; // set when we host
const chromeSocks = new Map<string, WebSocket>(); // Chrome profile id -> that profile's extension socket (profiles connect separately)
const unregistered = new Set<WebSocket>(); // connected but no hello yet (old builds) — treated as legacy "default"
let relaySock: WebSocket | null = null; // host session, when we're the relay client
let activeProfile: string | undefined; // which Chrome profile this session drives (browser_profile select)
let seq = 0;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
const pending = new Map<number, Pending>(); // our own outstanding commands
let armUsed = false; // set when this session sends any arm command — gates the close-on-settle guard

// host-side state for relayed commands from other pi sessions
type RelayEntry = { relay: WebSocket; id: number; timer: NodeJS.Timeout };
const relayPending = new Map<number, RelayEntry>();

function resolveMsg(raw: unknown) {
  let msg: { id: number; ok: boolean; result?: unknown; error?: string };
  try { msg = JSON.parse(String(raw)); } catch { return; }
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "unknown error"));
    return;
  }
  const rp = relayPending.get(msg.id); // response to a command relayed from another session
  if (rp) {
    relayPending.delete(msg.id);
    clearTimeout(rp.timer);
    rp.relay.send(JSON.stringify({ id: rp.id, ok: msg.ok, result: msg.result, error: msg.error }));
  }
}

// Route a command to the right Chrome profile's socket. With one profile
// connected everything goes there; with several, a profile must be selected.
function routeChrome(profile?: string): WebSocket {
  if (profile) {
    const s = chromeSocks.get(profile) ?? (profile === "default" && unregistered.size >= 1 ? [...unregistered][0] : undefined);
    if (!s) throw new Error(`no Chrome profile "${profile}" connected — connected: ${profileIds().join(", ") || "(none)"}`);
    return s;
  }
  if (chromeSocks.size === 1) return [...chromeSocks.values()][0];
  if (chromeSocks.size === 0 && unregistered.size === 1) return [...unregistered][0]; // legacy single connection, no hello
  if (chromeSocks.size === 0 && unregistered.size > 1) throw new Error("multiple Chrome connections from old extension builds — reload the extension in every profile");
  if (chromeSocks.size === 0) throw new Error("no Chrome connected — load chrome-extension/ in Chrome (chrome://extensions → Load unpacked)");
  throw new Error(`multiple Chrome profiles connected (${[...chromeSocks.keys()].join(", ")}) — pick one with browser_profile`);
}

const profileIds = (): string[] => (chromeSocks.size ? [...chromeSocks.keys()] : unregistered.size ? ["default"] : []);

function hostOrRelay() {
  const w = new WebSocketServer({ port: PORT });
  wss = w;
  w.once("error", (err: NodeJS.ErrnoException) => {
    w.close();
    wss = null;
    if (err.code === "EADDRINUSE") connectRelay();
    else console.error(`[browser-arm] ws server error: ${err.message}`);
  });
  w.on("connection", (ws, req) => {
    if ((req.url ?? "").endsWith("/chrome")) {
      // Chrome extension: incoming messages are responses to our commands.
      // It names its Chrome profile via hello; until then it stays
      // unregistered (legacy "default", kept out of the profile map).
      unregistered.add(ws);
      ws.on("message", (raw) => {
        let msg: { hello?: { profile?: string } };
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.hello?.profile) {
          unregistered.delete(ws);
          chromeSocks.set(msg.hello.profile, ws); // replaces any stale socket for the same profile (reconnect)
          return;
        }
        resolveMsg(raw);
      });
      ws.on("close", () => {
        unregistered.delete(ws);
        for (const [k, s] of chromeSocks) if (s === ws) chromeSocks.delete(k);
      });
    } else {
      // another pi session: its messages are commands to forward to Chrome
      ws.on("message", (raw) => {
        let msg: { id: number; cmd: string; params?: unknown; profile?: string };
        try { msg = JSON.parse(String(raw)); } catch { return; }
        try {
          if (msg.cmd === "profiles") { // answered by the host itself, no Chrome round-trip
            ws.send(JSON.stringify({ id: msg.id, ok: true, result: profileIds() }));
            return;
          }
          const out = routeChrome(msg.profile);
          const internal = ++seq;
          const timer = setTimeout(() => relayPending.delete(internal), TIMEOUT_MS + 5000);
          relayPending.set(internal, { relay: ws, id: msg.id, timer });
          out.send(JSON.stringify({ id: internal, cmd: msg.cmd, params: msg.params, agent: msg.agent }));
        } catch (e) {
          ws.send(JSON.stringify({ id: msg.id, ok: false, error: (e as Error).message }));
        }
      });
      ws.on("close", () => {
        for (const [k, e] of relayPending) if (e.relay === ws) { clearTimeout(e.timer); relayPending.delete(k); }
      });
    }
  });
}

function connectRelay() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on("open", () => { relaySock = ws; });
  ws.on("message", resolveMsg); // host forwards Chrome's responses with our ids preserved
  ws.on("close", () => {
    if (relaySock === ws) {
      relaySock = null;
      setTimeout(hostOrRelay, 1000); // host died — try to take over
    }
  });
  ws.on("error", () => ws.close());
}

async function arm<T = unknown>(cmd: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("aborted");
  armUsed = true;
  if (cmd === "profiles" && wss) return profileIds() as T; // host answers itself
  const out = wss ? routeChrome(activeProfile) : relaySock?.readyState === WebSocket.OPEN ? relaySock : null;
  if (!out) {
    throw new Error(
      `Browser Arm not connected. In Chrome: chrome://extensions → Load unpacked → chrome-extension/ from this repo. ` +
      `It dials ws://localhost:${PORT}/chrome.`,
    );
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${cmd} timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    out.send(JSON.stringify({ id, cmd, params, agent: AGENT_ID, profile: activeProfile }));
  });
}

// ---------- tools ----------

type RunResult = string | { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> };

export default function browserArm(pi: ExtensionAPI) {
  hostOrRelay();

  function tool(def: {
    name: string;
    label: string;
    description: string;
    parameters: any;
    run: (params: any, signal?: AbortSignal) => Promise<RunResult>;
  }) {
    pi.registerTool({
      ...def,
      async execute(_toolCallId, params, signal) {
        try {
          const r = await def.run(params, signal);
          if (typeof r === "string") return { content: [{ type: "text", text: r }], details: {} };
          return { content: r.content, details: {} };
        } catch (e) {
          return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true, details: {} };
        }
      },
    });
  }

  tool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Open a URL in this agent session's dedicated browser window (spawned on first use). newTab=true opens it in a fresh tab of that window instead of the current one. Waits for page load.",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL, e.g. https://example.com" }),
      newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab of this agent's window" })),
    }),
    run: (p) => arm<string>("navigate", p),
  });

  tool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "List interactive elements of the current page as numbered lines: `<id>: <tag> text`. " +
      "Use the ids with browser_click / browser_type. Re-snapshot after navigation — ids go stale.",
    parameters: Type.Object({}),
    run: () => arm<string>("snapshot"),
  });

  tool({
    name: "browser_click",
    label: "Browser Click",
    description: "Real mouse click on element #id from the last browser_snapshot.",
    parameters: Type.Object({ id: Type.Number({ description: "Element id from browser_snapshot" }) }),
    run: (p) => arm<string>("click", p),
  });

  tool({
    name: "browser_type",
    label: "Browser Type",
    description:
      "Click element #id and type text (real input events). submit=true presses Enter after typing. " +
      "mode='chars' sends one key event per character — use for inputs that listen for keydown or type-as-you-search.",
    parameters: Type.Object({
      id: Type.Number({ description: "Element id from browser_snapshot (input/textarea/contenteditable)" }),
      text: Type.String({ description: "Text to type; empty string to just focus" }),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
      mode: Type.Optional(Type.Union([Type.Literal("insert"), Type.Literal("chars")], {
        description: "insert (default) = fast. chars = per-character key events, slower but wakes keydown listeners",
      })),
    }),
    run: (p) => arm<string>("type", p),
  });

  tool({
    name: "browser_press",
    label: "Browser Press",
    description:
      "Press a special key in the focused element (click or type first to focus). " +
      "Keys: Enter, Tab, Backspace, Delete, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.",
    parameters: Type.Object({ key: Type.String({ description: "Key name, e.g. Enter or ArrowDown" }) }),
    run: (p) => arm<string>("press", p),
  });

  tool({
    name: "browser_read",
    label: "Browser Read",
    description: "Read the current page's visible text (up to 20k chars).",
    parameters: Type.Object({}),
    run: () => arm<string>("read"),
  });

  tool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Screenshot of the current viewport (jpeg), returned as an image for you to look at.",
    parameters: Type.Object({}),
    run: async (_p, signal) => {
      const shot = await arm<{ data: string }>("screenshot", {}, signal);
      return {
        content: [
          { type: "text", text: "Viewport screenshot (jpeg):" },
          { type: "image", data: shot.data, mimeType: "image/jpeg" },
        ],
      };
    },
  });

  tool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description: "Run arbitrary JS in the page, returns the JSON value. Escape hatch for anything the other tools can't do. Top-level await is a SyntaxError — wrap awaited code in (async () => { ... })().",
    parameters: Type.Object({ expression: Type.String({ description: "JS expression, e.g. document.title or (async () => (await fetch('/api')).status)()" }) }),
    run: (p) => arm<string>("evaluate", p),
  });

  tool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "Manage tabs: list (all tabs in the browser, with owning agent), select (adopt any tab as this agent's current tab, even outside its own window), close (default: this agent's current tab).",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("select"), Type.Literal("close")], { description: "Tab action" }),
      tabId: Type.Optional(Type.Number({ description: "Target tab id (from list). Default: this agent's current tab (close/select)" })),
    }),
    run: (p) => arm<unknown>("tabs", p).then((r) => JSON.stringify(r, null, 1)),
  });

  tool({
    name: "browser_profile",
    label: "Browser Profile",
    description:
      "Chrome profiles (people) with the arm installed each connect separately, each with its own cookies/logins. " +
      "list = connected profile ids; select = which one this session's browser_* tools drive. " +
      "Only needed when 2+ profiles are connected (with one, everything routes there automatically).",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("select")], { description: "Profile action" }),
      id: Type.Optional(Type.String({ description: "Profile id (from list, for select)" })),
    }),
    run: async (p) => {
      const listIds = async () =>
        arm<string[]>("profiles").catch((e) => {
          if (/unknown command/i.test(e.message))
            throw new Error("the hosting pi session runs an older Browser Arm build without profile support — close/restart it so a current session takes over, then retry (check with /arm)");
          throw e;
        });
      if (p.action === "list") return JSON.stringify(await listIds(), null, 1);
      if (!p.id) throw new Error("browser_profile select needs id (from browser_profile list)");
      const ids = await listIds();
      if (!ids.includes(p.id)) throw new Error(`no profile "${p.id}" connected — connected: ${ids.join(", ") || "(none)"}`);
      activeProfile = p.id;
      return `This session now drives Chrome profile ${p.id}`;
    },
  });

  pi.registerCommand("arm", {
    description: "Browser Arm status",
    handler: async (_args, ctx) => {
      let msg: string;
      const n = chromeSocks.size;
      if (wss && n > 0) msg = `Browser Arm [${AGENT_ID}] hosting ws://localhost:${PORT}, Chrome connected (${n} profile${n > 1 ? "s" : ""}: ${[...chromeSocks.keys()].join(", ")}${activeProfile ? ", driving " + activeProfile : ""})`;
      else if (wss) msg = `Browser Arm [${AGENT_ID}] hosting ws://localhost:${PORT}, waiting for Chrome (load chrome-extension/ unpacked)`;
      else if (relaySock?.readyState === WebSocket.OPEN) msg = `Browser Arm [${AGENT_ID}] relaying through the host pi session on port ${PORT}`;
      else msg = `Browser Arm [${AGENT_ID}] not connected — load chrome-extension/ in Chrome (dials ws://localhost:${PORT}/chrome)`;
      ctx.ui.notify(msg, "info");
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // run done and nothing else started → close this session's arm window
    // (respawns automatically on the next browser command; page state is not kept between runs)
    if (!armUsed || !ctx.isIdle()) return;
    armUsed = false;
    try { await arm("session-close"); } catch { /* arm down */ }
  });

  pi.on("session_shutdown", async () => {
    // wipe this session's arm window immediately (fire-and-forget; ignore if already gone)
    try { await arm("session-close"); } catch { /* arm already down */ }
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("session ended")); }
    pending.clear();
    for (const [, e] of relayPending) clearTimeout(e.timer);
    relayPending.clear();
    chromeSocks.clear();
    activeProfile = undefined;
    relaySock = null;
    wss?.close();
    wss = null;
  });
}
