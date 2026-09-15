// Fake Browser Arm: stands in for the Chrome extension so you can test the pi
// side without a browser. Usage: node fake-arm.js (ARM_PROFILE_ID=name to
// simulate a second Chrome profile). Every command gets a canned response.
import { WebSocket } from "ws";

const PORT = process.env.BROWSER_ARM_PORT || 8765;
const PROFILE = process.env.ARM_PROFILE_ID || "default";
let ws;

function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}/chrome`);
  ws.on("open", () => {
    console.log(`[fake-arm:${PROFILE}] connected to ws://localhost:${PORT}`);
    ws.send(JSON.stringify({ hello: { profile: PROFILE } }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    console.log(`[fake-arm:${PROFILE}] <- ${msg.cmd}`, msg.params);
    ws.send(JSON.stringify({ id: msg.id, ok: true, result: `fake ${msg.cmd} ok profile=${PROFILE}` }));
  });
  ws.on("close", () => setTimeout(connect, 2000));
  ws.on("error", (e) => console.error(`[fake-arm:${PROFILE}] ${e.message}`));
}
connect();
