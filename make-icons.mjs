// Generates chrome-extension/icons/icon{16,32,48,128}.png — indigo rounded
// square with a white arm. Pure stdlib (zlib), no image deps. Run: node make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// white arm silhouette over indigo: shoulder dot, upper arm, open claw
function armCoverage(u, v) {
  const inRect = (() => {
    const margin = 0.06, r = 0.16;
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - margin - r), 0);
    const qy = Math.max(Math.abs(v - 0.5) - (0.5 - margin - r), 0);
    return Math.hypot(qx, qy) <= r;
  })();
  if (!inRect) return 0;
  const dot = Math.hypot(u - 0.28, v - 0.72) <= 0.1;
  const arm = segDist(u, v, 0.28, 0.72, 0.58, 0.42) <= 0.055;
  const claw1 = segDist(u, v, 0.58, 0.42, 0.74, 0.34) <= 0.05;
  const claw2 = segDist(u, v, 0.58, 0.42, 0.72, 0.18) <= 0.05;
  return dot || arm || claw1 || claw2 ? 1 : 0;
}

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        cov += armCoverage((x + sx) / size, (y + sy) / size);
      }
      cov /= 4; // cheap 2x2 supersampling
      const o = y * stride + 1 + x * 4;
      raw[o] = Math.round(79 + (255 - 79) * cov); // mix bg #4F46E5 -> white
      raw[o + 1] = Math.round(70 + (255 - 70) * cov);
      raw[o + 2] = Math.round(229 + (255 - 229) * cov);
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("chrome-extension/icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`chrome-extension/icons/icon${size}.png`, png(size));
  console.log(`icon${size}.png`);
}
