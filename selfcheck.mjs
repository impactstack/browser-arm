// Self-check: exercises the real pi-side bridge (server + request/response
// correlation) against fake-arm.js, then verifies a second pi session can
// relay through the host. No Chrome, no LLM needed. Run: npm test
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import factory from "./pi-extension/index.ts";

const selfPath = fileURLToPath(import.meta.url);

if (process.argv.includes("--relay-probe")) {
  // Simulates a second pi session: the port is taken by the parent's host
  // server, so the factory must fall back to relay mode and still round-trip.
  const tools = {};
  const events = {};
  factory({
    registerTool: (t) => { tools[t.name] = t; },
    registerCommand: () => {},
    on: (name, handler) => { events[name] = handler; },
  });
  const end = Date.now() + 8000;
  let last;
  while (Date.now() < end) {
    last = await tools.browser_tabs.run({ action: "list" }).catch((e) => e);
    if (!(last instanceof Error)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (last instanceof Error || !String(last).includes("fake tabs ok")) {
    console.error("PROBE FAIL:", last);
    process.exit(1);
  }
  await events.session_shutdown?.();
  console.log("ok: relay probe — second session drove the arm through the host");
  process.exit(0);
}

// ---- main mode: we are the host session ----

const tools = {};
const events = {};
factory({
  registerTool: (t) => { tools[t.name] = t; },
  registerCommand: () => {},
  on: (name, handler) => { events[name] = handler; },
});

const fake = spawn(process.execPath, ["fake-arm.js"], { stdio: "inherit" });

const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); fake.kill(); fakeB?.kill(); process.exit(1); }
  console.log("ok:", msg);
};
let fakeB;

// retry until fake-arm has connected to the server
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => e);
    if (!(last instanceof Error)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw last;
}

try {
  const tabs = await until(() => tools.browser_tabs.run({ action: "list" }));
  assert(String(tabs).includes("fake tabs ok"), "browser_tabs round-trips through the bridge");
  assert(String(await tools.browser_evaluate.run({ expression: "1+1" })).includes("fake evaluate ok"), "browser_evaluate round-trips");
  assert(String(await tools.browser_click.run({ id: 5 })).includes("fake click ok"), "browser_click round-trips");
  assert(String(await tools.browser_type.run({ id: 3, text: "hi", mode: "chars" })).includes("fake type ok"), "browser_type round-trips");
  assert(String(await tools.browser_press.run({ key: "Enter" })).includes("fake press ok"), "browser_press round-trips");

  const probe = spawn(process.execPath, [selfPath, "--relay-probe"], { stdio: "inherit" });
  const code = await new Promise((r) => probe.on("exit", (c) => r(c)));
  assert(code === 0, "second session relays through the host");

  // ---- multi-profile: a second Chrome profile connects; routing must respect selection ----
  fakeB = spawn(process.execPath, ["fake-arm.js"], { stdio: "inherit", env: { ...process.env, ARM_PROFILE_ID: "profile-b" } });
  const profileList = async () => tools.browser_profile.run({ action: "list" }).then(JSON.parse).catch(() => null);
  const both = await until(async () => {
    const l = await profileList();
    return Array.isArray(l) && l.includes("profile-b") && l.includes("default") ? l : Promise.reject(new Error("waiting"));
  });
  assert(both.includes("profile-b") && both.includes("default"), "browser_profile lists both connected profiles");

  const ambiguous = await tools.browser_tabs.run({ action: "list" }).catch((e) => e);
  assert(ambiguous instanceof Error && /multiple Chrome profiles/.test(ambiguous.message), "ambiguous commands fail listing the profiles");

  assert(String(await tools.browser_profile.run({ action: "select", id: "profile-b" })).includes("profile-b"), "browser_profile select works");
  assert(String(await tools.browser_tabs.run({ action: "list" })).includes("profile=profile-b"), "commands route to the selected profile");
  assert(String(await tools.browser_profile.run({ action: "select", id: "default" })).includes("default"), "switching profiles works");
  assert(String(await tools.browser_tabs.run({ action: "list" })).includes("profile=default"), "commands route back to the first profile");
  const bad = await tools.browser_profile.run({ action: "select", id: "nope" }).catch((e) => e);
  assert(bad instanceof Error && /no profile/.test(bad.message), "selecting an unknown profile fails clearly");

  fakeB.kill();
  await until(async () => {
    const l = await profileList();
    return Array.isArray(l) && l.length === 1 && l[0] === "default" ? l : Promise.reject(new Error("waiting"));
  });
  assert(true, "disconnected profile disappears from the list");

  console.log("ALL CHECKS PASSED");
} finally {
  fake.kill();
  fakeB?.kill();
  await events.session_shutdown?.(); // close the ws server so node can exit
}
