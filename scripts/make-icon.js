'use strict';
// Render fren's app icon: the amber orb on a dark macOS-style rounded square,
// then build the .icns the packaged app uses. Pure Node for the artwork (every
// pixel computed, no rasterizer dependency); macOS sips + iconutil for the
// iconset. `npm run pack` runs this if packaging/icon.icns is missing.
const fs = require('fs');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SIZE = 1024;
const SS = 2;               // supersample factor for clean edges/gradients
const W = SIZE * SS, H = SIZE * SS;

// ---- palette (from the renderer's orb) ----
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

// sphere gradient stops (distance-from-highlight → color)
const STOPS = [
  [0.00, hex('#FFF7E6')],
  [0.14, hex('#FFE7B5')],
  [0.34, hex('#FFB14A')],
  [0.57, hex('#FF8A00')],
  [0.80, hex('#E56B00')],
  [1.00, hex('#9C4600')],
];
function ramp(t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const bgTop = hex('#20242e'), bgBot = hex('#0a0b0f');
const glowCol = hex('#FF9012');

// geometry (in supersampled space)
const cx = W / 2, cy = H / 2;
const margin = 92 * SS;                 // transparent inset around the rounded square
const half = (SIZE / 2 - 92) * SS;      // half-extent of the rounded square
const radius = 200 * SS;                // corner radius
const R = 306 * SS;                     // orb radius
const hx = cx - 96 * SS, hy = cy - 120 * SS; // highlight centre (up-left)

// fren's face, mapped onto the orb. Geometry mirrors renderer/face/face-texture.js
// (FACE): a 200-unit box the size of the orb, wide-set round eyes and a small
// resting smile, all drawn as white-hot features with a warm amber halo.
const faceScale = (2 * R) / 200;
const fpt = (fx, fy) => [cx + (fx - 100) * faceScale, cy + (fy - 100) * faceScale];
const [ex1, eyeY] = fpt(100 - 38, 90);  // EYE_DX 38, EYE_Y 90
const [ex2] = fpt(100 + 38, 90);
const eRx = 15.2 * faceScale, eRy = 15.2 * 1.06 * faceScale; // EYE_R, a touch taller
// The open smile: the filled mouth shape from face-texture.js mouthPath (two
// cubic edges — a shallow top lip and a deeper bottom), sampled into a polygon.
const MOUTH_OPEN = 0.5, MOUTH_W = 32, MOUTH_Y = 128, kx = MOUTH_W * 0.94, kk = 1.3333;
const lip = 0.8 * 5.0, drop = MOUTH_OPEN * (7 + MOUTH_W * 0.42);
const topY = lip - drop * 0.1, botY = lip + drop;
const cubic = (p0, c1, c2, p3, n) => {
  const o = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    o.push([u*u*u*p0[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*p3[0],
            u*u*u*p0[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*p3[1]]);
  }
  return o;
};
const mouthPoly = [
  ...cubic([100 - MOUTH_W, MOUTH_Y], [100 - kx, MOUTH_Y + topY*kk], [100 + kx, MOUTH_Y + topY*kk], [100 + MOUTH_W, MOUTH_Y], 30),
  ...cubic([100 + MOUTH_W, MOUTH_Y], [100 + kx, MOUTH_Y + botY*kk], [100 - kx, MOUTH_Y + botY*kk], [100 - MOUTH_W, MOUTH_Y], 30),
].map(([fx, fy]) => fpt(fx, fy));
const mStrokeHalf = 7.0 * faceScale / 2; // the mouth is filled AND stroked (round)
const AA = 1.4 * SS;
let mbx0 = 1e9, mby0 = 1e9, mbx1 = -1e9, mby1 = -1e9;
for (const [px, py] of mouthPoly) { mbx0 = Math.min(mbx0, px); mby0 = Math.min(mby0, py); mbx1 = Math.max(mbx1, px); mby1 = Math.max(mby1, py); }
const eyeBox = [Math.min(ex1, ex2) - eRx - AA, eyeY - eRy - AA, Math.max(ex1, ex2) + eRx + AA, eyeY + eRy + AA];
const mouthBox = [mbx0 - mStrokeHalf - AA, mby0 - mStrokeHalf - AA, mbx1 + mStrokeHalf + AA, mby1 + mStrokeHalf + AA];

// Signed distance to the mouth polygon (negative inside), for a crisp filled edge.
function polySD(px, py, poly) {
  let inside = false, minD = 1e18;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const dx = xj - xi, dy = yj - yi;
    const t = Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / (dx*dx + dy*dy || 1)));
    const ex = xi + t*dx - px, ey = yi + t*dy - py, d = ex*ex + ey*ey;
    if (d < minD) minD = d;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return (inside ? -1 : 1) * Math.sqrt(minD);
}

function sdRoundRect(px, py) {
  const qx = Math.abs(px - cx) - half + radius;
  const qy = Math.abs(py - cy) - half + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

const buf = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;

    // rounded-square background with AA
    const sd = sdRoundRect(x + 0.5, y + 0.5);
    const rectCov = clamp(0.5 - sd / SS, 0, 1);
    if (rectCov > 0) {
      // vertical gradient + gentle radial vignette
      const vy = (y - (cy - half)) / (2 * half);
      let bg = mix(bgTop, bgBot, clamp(vy, 0, 1));
      const vig = smooth(half * 1.5, half * 0.15, Math.hypot(x - cx, y - cy));
      bg = mix(bg, bgBot, vig * 0.7);
      r = bg[0]; g = bg[1]; b = bg[2]; a = 255 * rectCov;

      const d = Math.hypot(x - cx, y - cy);

      // outer amber glow (additive), fading out from the orb rim — kept tight
      // and low so the sphere reads crisp against the dark ground, not radiant
      const glow = Math.exp(-Math.max(0, d - R) / (52 * SS)) * 0.18;
      if (glow > 0.002) { r += glowCol[0] * glow; g += glowCol[1] * glow; b += glowCol[2] * glow; }

      // the orb itself
      const orbCov = smooth(R + 1.2 * SS, R - 1.2 * SS, d);
      if (orbCov > 0) {
        const hd = Math.hypot(x - hx, y - hy);
        let col = ramp(hd / (R * 1.24));
        // rim darkening at the very edge for a rounder read
        const rim = smooth(R * 0.82, R, d);
        col = mix(col, hex('#7A3600'), rim * 0.35);
        // warm bounce light along the lower-right limb
        const bounce = smooth(R, R * 0.86, d) * smooth(-0.2, 1, ((x - cx) + (y - cy)) / (R * 1.4));
        col = [col[0] + 60 * bounce, col[1] + 26 * bounce, col[2] + 6 * bounce];
        // tiny hot specular dot — tighter, so it reads as a glossy hotspot
        const spec = Math.exp(-Math.pow(hd / (40 * SS), 2)) * 0.85;
        col = [col[0] + (255 - col[0]) * spec, col[1] + (255 - col[1]) * spec, col[2] + (250 - col[2]) * spec];

        // --- the face: clean white eyes + open smile, no halo ---
        let fCore = 0;
        if (x >= eyeBox[0] && x <= eyeBox[2] && y >= eyeBox[1] && y <= eyeBox[3]) {
          for (const ex of [ex1, ex2]) {
            const nd = Math.hypot((x - ex) / eRx, (y - eyeY) / eRy);
            const aa = 1.4 / eRx;
            fCore = Math.max(fCore, smooth(1 + aa, 1 - aa, nd));
          }
        }
        if (x >= mouthBox[0] && x <= mouthBox[2] && y >= mouthBox[1] && y <= mouthBox[3]) {
          const sd = polySD(x, y, mouthPoly);
          fCore = Math.max(fCore, smooth(mStrokeHalf + AA, mStrokeHalf - AA, sd));
        }
        if (fCore > 0.002) {
          col = [lerp(col[0], 255, fCore), lerp(col[1], 250, fCore), lerp(col[2], 238, fCore)];
        }

        r = lerp(r, col[0], orbCov); g = lerp(g, col[1], orbCov); b = lerp(b, col[2], orbCov);
      }
    }

    const o = (y * W + x) * 4;
    buf[o] = clamp(Math.round(r), 0, 255);
    buf[o + 1] = clamp(Math.round(g), 0, 255);
    buf[o + 2] = clamp(Math.round(b), 0, 255);
    buf[o + 3] = clamp(Math.round(a), 0, 255);
  }
}

// ---- downsample SSxSS → 1x (box filter) ----
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const o = ((y * SS + sy) * W + (x * SS + sx)) * 4;
      r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
    }
    const n = SS * SS, o = (y * SIZE + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
  }
}

// ---- encode PNG ----
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) { raw[y * (SIZE * 4 + 1)] = 0; out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); }
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const outDir = path.join(__dirname, '..', 'packaging');
fs.mkdirSync(outDir, { recursive: true });
const src = path.join(outDir, 'icon-1024.png');
fs.writeFileSync(src, png);
console.log('rendered', path.relative(process.cwd(), src), (png.length / 1024).toFixed(0) + 'KB');

// ---- .icns via the macOS iconset convention ----
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'fren-iconset-')) + '/icon.iconset';
fs.mkdirSync(iconset, { recursive: true });
const variants = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];
for (const [px, name] of variants) {
  execFileSync('sips', ['-z', String(px), String(px), src, '--out', path.join(iconset, name)], { stdio: 'ignore' });
}
const icns = path.join(outDir, 'icon.icns');
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns]);
fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
console.log('built', path.relative(process.cwd(), icns), (fs.statSync(icns).size / 1024).toFixed(0) + 'KB');
