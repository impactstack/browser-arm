// Fake Browser Arm: stands in for the Chrome extension so you can test the pi
// side without a browser. Usage: node fake-arm.js
// Run pi in another terminal and try /arm or browser_tabs list — every command
// gets a canned response (screenshot data is garbage, just proves the loop).
import { WebSocket } from "ws";

const PORT = process.env.BROWSER_ARM_PORT || 8765;
let ws;

function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}/chrome`);
  ws.on("open", () => console.log(`[fake-arm] connected to ws://localhost:${PORT}`));
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    console.log(`[fake-arm] <- ${msg.cmd}`, msg.params);
    ws.send(JSON.stringify({ id: msg.id, ok: true, result: `fake ${msg.cmd} ok ${JSON.stringify(msg.params)}` }));
  });
  ws.on("close", () => setTimeout(connect, 2000));
  ws.on("error", (e) => console.error(`[fake-arm] ${e.message}`));
}
connect();
