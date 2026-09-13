// Browser Arm — Chrome side.
// Dials the pi extension's WS server (ws://localhost:PORT/chrome) and executes
// commands against per-agent windows via chrome.debugger (CDP).
// Multiple pi sessions relay through one host, so every command carries an
// `agent` id: each agent session gets its own dedicated window (spawned on
// first use) and its own element-id namespace. All of the agent's tabs live
// inside that window; the current tab is just the window's active tab.
const PORT = 8765;
const WS_URL = `ws://localhost:${PORT}/chrome`; // /chrome = "I'm the browser"; bare / = another pi session relaying
const LOAD_TIMEOUT = 15000;

let ws;
const agentTabs = new Map();    // agent id -> explicitly selected tabId (tabs select; may live outside the agent's window)
const agentWindows = new Map(); // agent id -> windowId (per-agent session window)
const ownedWindows = new Set(); // window ids the arm created — the only ones safe to auto-close
const IDLE_CLOSE_MS = 10 * 60 * 1000; // reap an agent's window after this much inactivity
const attached = new Set();

// MV3 keeps a service worker alive only while it's "active" — WS traffic
// resets the idle timer, so ping while connected; if the SW still dies
// (Chrome force-kill), the alarm wakes it and top-level connect() re-dials.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: true }));
}, 20000);
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log(`[arm] connected ${WS_URL}`);
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg).catch((err) => console.error("[arm]", err));
  };
  ws.onclose = () => setTimeout(connect, 2000);
  ws.onerror = () => ws.close();
}
connect();

// serialize each agent's multi-step sequences (click/type) so concurrent
// agents can't interleave half a click or half a typed string
const queues = new Map();

async function handle({ id, cmd, params = {}, agent = "default" }) {
  const prev = queues.get(agent) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    try {
      const result = await handlers[cmd](params, agent);
      send({ id, ok: true, result });
    } catch (err) {
      send({ id, ok: false, error: String((err && err.message) || err) });
    }
    bumpIdle(agent); // restart the 10-minute window reap countdown
  });
  queues.set(agent, next);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// MV3 service workers sleep and kill plain timers, so the idle reaper uses
// chrome.alarms — they survive SW restarts and fire even after long silence.
function bumpIdle(agent) {
  chrome.alarms.create(`reap-${agent}`, { when: Date.now() + IDLE_CLOSE_MS });
}

async function reapAgent(agent) {
  agentTabs.delete(agent);
  const winId = agentWindows.get(agent);
  agentWindows.delete(agent);
  // only close windows the arm created — never a user window the agent adopted via tabs select
  if (winId != null && ownedWindows.has(winId)) {
    ownedWindows.delete(winId);
    try { await chrome.windows.remove(winId); } catch { /* already gone */ }
  }
}

// ---------- tab + debugger helpers ----------

// This agent's dedicated window: the live one, or a freshly spawned one
// (unfocused so concurrent agents don't steal each other's focus; cascaded so
// windows don't stack pixel-identical).
async function agentWindow(agent) {
  const winId = agentWindows.get(agent);
  if (winId != null) {
    try { return await chrome.windows.get(winId, { populate: true }); } catch { agentWindows.delete(agent); }
  }
  const n = ownedWindows.size;
  const win = await chrome.windows.create({ url: "about:blank", focused: false, left: 60 + n * 40, top: 40 + n * 40 });
  ownedWindows.add(win.id);
  agentWindows.set(agent, win.id);
  return win;
}

// Current tab: explicitly adopted one (tabs select — may live in any window,
// driven over CDP without touching focus), else the dedicated window's active tab.
async function currentTab(agent) {
  const tabId = agentTabs.get(agent);
  if (tabId != null) {
    try { return await chrome.tabs.get(tabId); } catch { agentTabs.delete(agent); }
  }
  const win = await agentWindow(agent);
  const tab = win.tabs?.find((t) => t.active) ?? win.tabs?.[0];
  return tab && tab.id != null ? tab : null;
}

async function requireTab(agent) {
  const tab = await currentTab(agent);
  if (!tab) throw new Error("no usable tab in this agent's window — use browser_navigate");
  // chrome:// and other extensions' chrome-extension:// pages reject chrome.debugger
  // ("Cannot access a chrome-extension:// URL of different extension") — fail early
  // with a way out instead of CDP's cryptic error.
  if (!/^(https?:|about:blank)/.test(tab.url || "")) {
    throw new Error(
      `can't drive "${String(tab.url).slice(0, 50)}" — browser-internal pages reject the debugger. ` +
      `browser_navigate this tab to a real URL, or browser_tabs select an http(s) tab`,
    );
  }
  return tab;
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  attached.add(tabId);
}

async function cdp(tabId, method, params) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evalInTab(tabId, expression) {
  const r = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page JS error");
  }
  return r.result?.value;
}

function armSel(agent, id) {
  if (!/^\d+$/.test(String(id))) throw new Error(`bad element id "${id}" — use ids from browser_snapshot`);
  return `[data-arm-id="${agent}:${id}"]`; // ids are namespaced per agent, safe to share a tab
}

async function centerOf(tabId, agent, id) {
  const sel = armSel(agent, id);
  await evalInTab(tabId, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) throw new Error("element #${id} gone — run browser_snapshot again");
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await new Promise((r) => setTimeout(r, 150)); // let scrollIntoView settle
  return evalInTab(tabId, `(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
}

async function clickAt(tabId, pt) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type, x: pt.x, y: pt.y, button: "left", clickCount: 1,
    });
  }
}

const KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};

async function dispatchKey(tabId, k) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
  });
}

function snapshotJs(agent) {
  return `(() => {
    const prefix = ${JSON.stringify(agent + ":")};
    const sel = 'a,button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=combobox],[role=textbox],[onclick],[contenteditable]';
    const all = [...document.querySelectorAll(sel)];
    const els = all.filter(e => e.getClientRects().length > 0 && !all.some(p => p !== e && p.contains(e))); // ponytail: O(n²) dedupe, fine at page scale
    els.slice(0, 200).forEach((e, i) => e.setAttribute("data-arm-id", prefix + (i + 1)));
    const lines = els.slice(0, 200).map((e, i) => {
      const tag = e.tagName.toLowerCase();
      const type = e.getAttribute("type");
      const text = (e.innerText || e.value || e.selectedOptions?.[0]?.text || e.placeholder || e.getAttribute("aria-label") || e.getAttribute("title") || "")
        .trim().replace(/\\s+/g, " ").slice(0, 90);
      return (i + 1) + ": <" + tag + (type ? " type=" + type : "") + (e.checked === true ? " checked" : "") + "> " + text;
    });
    return lines.join("\\n") || "(no interactive elements)";
  })()`;
}

// ---------- command handlers ----------

const handlers = {
  async navigate({ url, newTab }, agent) {
    const u = new URL(url); // validates
    let tab;
    if (newTab) {
      const win = await agentWindow(agent);
      tab = await chrome.tabs.create({ windowId: win.id, url: u.href, active: true }); // many tabs per agent window
    } else {
      tab = await currentTab(agent);
      await chrome.tabs.update(tab.id, { url: u.href });
    }
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, LOAD_TIMEOUT);
    });
    const t2 = await chrome.tabs.get(tab.id);
    return `Loaded: ${t2.title} — ${t2.url}`;
  },

  async snapshot(_params, agent) {
    const tab = await requireTab(agent);
    return evalInTab(tab.id, snapshotJs(agent));
  },

  async click({ id }, agent) {
    const tab = await requireTab(agent);
    await clickAt(tab.id, await centerOf(tab.id, agent, id));
    return `Clicked #${id}`;
  },

  async type({ id, text, submit, mode }, agent) {
    const tab = await requireTab(agent);
    await clickAt(tab.id, await centerOf(tab.id, agent, id));
    if (mode === "chars") {
      // real key events, one per character — wakes keydown/autocomplete listeners
      for (const ch of String(text)) {
        if (ch === "\n") await dispatchKey(tab.id, KEYS.enter);
        else {
          await dispatchKey(tab.id, { key: ch, code: "", vk: ch.toUpperCase().charCodeAt(0), text: ch });
          await new Promise((r) => setTimeout(r, 15));
        }
      }
    } else if (text) {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", { text: String(text) });
    }
    if (submit) await dispatchKey(tab.id, KEYS.enter);
    return `Typed into #${id} (${mode || "insert"})${submit ? " + Enter" : ""}`;
  },

  async press({ key }, agent) {
    const tab = await requireTab(agent);
    const k = KEYS[String(key).toLowerCase()];
    if (!k) throw new Error(`unknown key "${key}" — one of: ${Object.keys(KEYS).join(", ")}`);
    await attach(tab.id);
    await dispatchKey(tab.id, k);
    return `Pressed ${k.key}`;
  },

  async read(_params, agent) {
    const tab = await requireTab(agent);
    const text = await evalInTab(tab.id, "document.body?.innerText || ''");
    return String(text).slice(0, 20000) || "(empty page)";
  },

  async screenshot(_params, agent) {
    const tab = await requireTab(agent);
    const shot = await cdp(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return { data: shot.data };
  },

  async evaluate({ expression }, agent) {
    const tab = await requireTab(agent);
    const v = await evalInTab(tab.id, expression);
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
    return s == null ? "undefined" : String(s).slice(0, 50000);
  },

  // Own window is home base, but select can adopt any tab in the browser.
  // Adopted tabs are driven via CDP without activating/focusing their window,
  // so agents never steal focus from the user or each other.
  async tabs({ action, tabId }, agent) {
    if (action === "list") {
      const owner = new Map([...agentTabs].map(([a, t]) => [t, a]));
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((t) => /^(https?|about|chrome-extension):/.test(t.url || ""))
        .map((t) => ({ id: t.id, active: t.active, agent: owner.get(t.id) || null, title: t.title, url: t.url }));
    }
    if (action === "select") {
      if (tabId == null) throw new Error("tabs select needs tabId (from browser_tabs list)");
      await chrome.tabs.get(tabId); // throws if the tab is gone
      agentTabs.set(agent, tabId);
      return `Tab ${tabId} is now this agent's current tab`;
    }
    if (action === "close") {
      // never call currentTab here — it spawns the agent's window as a side effect
      let id = tabId ?? agentTabs.get(agent);
      const winId = agentWindows.get(agent);
      if (id == null && winId != null) {
        const win = await chrome.windows.get(winId, { populate: true }).catch(() => null);
        id = (win?.tabs?.find((t) => t.active) || win?.tabs?.[0])?.id;
      }
      if (id == null) throw new Error("no tab to close");
      await chrome.tabs.remove(id); // last tab of a window → window closes → onRemoved cleans up
      return `Closed tab ${id}`;
    }
    throw new Error(`unknown tabs action "${action}" (list | select | close)`);
  },
};

// ---------- cleanup ----------

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  for (const [a, t] of agentTabs) if (t === tabId) agentTabs.delete(a);
});

chrome.windows.onRemoved.addListener((winId) => {
  ownedWindows.delete(winId);
  for (const [a, w] of agentWindows) if (w === winId) { agentWindows.delete(a); chrome.alarms.clear(`reap-${a}`); }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name.startsWith("reap-")) reapAgent(a.name.slice(5));
});

chrome.debugger.onDetach.addListener((src) => {
  // user clicked "Cancel" on the debugging infobar
  if (src.tabId != null) attached.delete(src.tabId);
});
