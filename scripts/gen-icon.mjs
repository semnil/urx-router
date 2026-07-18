// Generates a 1024x1024 source PNG for the app icon with no third-party deps.
// The mark is the routing motif: two jack ports joined by a glowing amber wire
// on a dark studio-rack background. Feed the output to `pnpm tauri icon`.
//
//   node scripts/gen-icon.mjs            # writes scripts/app-icon.png
//   pnpm tauri icon scripts/app-icon.png # expands into src-tauri/icons/

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const N = 1024;

// --- tiny vector helpers -----------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp01(t);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Cubic bezier sampled into a polyline, then min distance to the polyline.
function bezier(p0, p1, p2, p3, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
    pts.push([x, y]);
  }
  return pts;
}
function distToPath(px, py, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (d < best) best = d;
  }
  return best;
}

// Source-over compositing of a straight (premultiplied-free) RGBA layer.
function over(dst, src) {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a <= 0) return [0, 0, 0, 0];
  const f = (i) => (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a;
  return [f(0), f(1), f(2), a];
}

// --- scene -------------------------------------------------------------------

const R = 224; // background corner radius
const wire = bezier([300, 600], [512, 600], [512, 424], [724, 424], 220);
const portA = [300, 600];
const portB = [724, 424];

const AMBER = [255, 184, 77];
const AMBER_LIT = [255, 210, 122];
const RING = [12, 10, 7];

function roundedCornerCoverage(x, y) {
  // Distance outside the rounded square (0 inside, grows outside the corners).
  const dx = Math.max(R - x, x - (N - R), 0);
  const dy = Math.max(R - y, y - (N - R), 0);
  if (dx === 0 || dy === 0) return 1; // straight edges
  const d = Math.hypot(dx, dy);
  return 1 - smoothstep(R - 1, R + 1, d);
}

function pixel(x, y) {
  // Background gradient (top lighter), masked to a rounded square.
  const g = y / N;
  const bg = [Math.round(36 - 18 * g), Math.round(28 - 13 * g), Math.round(17 - 7 * g)];
  const bgCov = roundedCornerCoverage(x, y);
  let c = [bg[0], bg[1], bg[2], bgCov];

  const dWire = distToPath(x, y, wire);
  // Wire glow then core.
  const glow = (1 - smoothstep(20, 90, dWire)) * 0.5;
  if (glow > 0) c = over(c, [AMBER[0], AMBER[1], AMBER[2], glow]);
  const core = 1 - smoothstep(22, 25, dWire);
  if (core > 0) c = over(c, [AMBER[0], AMBER[1], AMBER[2], core]);

  for (const p of [portA, portB]) {
    const d = Math.hypot(x - p[0], y - p[1]);
    // Outer ring: dark fill with an amber rim.
    const fill = 1 - smoothstep(69, 71, d);
    if (fill > 0) c = over(c, [RING[0], RING[1], RING[2], fill]);
    const rim = (1 - smoothstep(70, 72, d)) * smoothstep(54, 57, d);
    if (rim > 0) c = over(c, [AMBER[0], AMBER[1], AMBER[2], rim]);
    // Lit pin with a soft halo.
    const halo = (1 - smoothstep(26, 60, d)) * 0.45;
    if (halo > 0) c = over(c, [AMBER_LIT[0], AMBER_LIT[1], AMBER_LIT[2], halo]);
    const pin = 1 - smoothstep(25, 28, d);
    if (pin > 0) c = over(c, [AMBER_LIT[0], AMBER_LIT[1], AMBER_LIT[2], pin]);
  }
  return c;
}

// --- raster + PNG encode -----------------------------------------------------

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0; // filter type 0
  for (let x = 0; x < N; x++) {
    const c = pixel(x + 0.5, y + 0.5);
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(clamp01(c[0] / 255) * 255);
    raw[o + 1] = Math.round(clamp01(c[1] / 255) * 255);
    raw[o + 2] = Math.round(clamp01(c[2] / 255) * 255);
    raw[o + 3] = Math.round(clamp01(c[3]) * 255);
  }
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = new URL("./app-icon.png", import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${png.length} bytes)`);
