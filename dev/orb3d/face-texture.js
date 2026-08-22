'use strict';
/**
 * fren's face, drawn to a canvas so it can be used as a texture.
 *
 * This is deliberately the SAME geometry as the SVG renderer — the eyes are
 * plain circles, and the mouth is one path filled AND stroked with round caps
 * and joins so its outline is always round. Proving the drawing survives a
 * change of renderer is half the point of this prototype: the parameter space
 * is what the character is, not the SVG.
 */
export const FACE = { EYE_DX: 36, EYE_Y: 88, EYE_R: 11, MOUTH_Y: 118, MOUTH_W: 48 };

/** The mouth path, in the same 200-unit space the SVG uses. */
function mouthPath(ctx, cx, cy, wScale, open, curve, wave) {
  const w = FACE.MOUTH_W * Math.max(0.1, Math.min(1.6, wScale));
  const c = Math.max(-1, Math.min(1, curve));
  const kx = w * 0.94;              // near the corners -> vertical sides
  const lip = c * 10;
  const drop = open * (13 + w * 0.46);
  const top = lip - drop * 0.1;
  const bot = lip + drop;
  const k = 1.3333;
  const s = wave * 8;

  ctx.beginPath();
  ctx.moveTo(cx - w, cy);
  ctx.bezierCurveTo(cx - kx, cy + top * k + s, cx + kx, cy + top * k - s, cx + w, cy);
  ctx.bezierCurveTo(cx + kx, cy + bot * k - s, cx - kx, cy + bot * k + s, cx - w, cy);
  ctx.closePath();
}

/**
 * Paint the face into a canvas. `p` uses the same parameter names as the SVG
 * renderer, so both can be driven from one spring system.
 */
export function drawFace(canvas, p) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width / 200;          // the face lives in a 200-unit box
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(S, 0, 0, S, 0, (canvas.height - 200 * S) / 2);

  const lit = Math.max(0, Math.min(1, p.lit ?? 1));
  if (lit <= 0.02) return;               // light off: nothing emits

  const ink = `rgba(255,255,255,${(0.9 + lit * 0.1).toFixed(3)})`;

  // --- eyes: plain circles with a hot core, so they read as lamps ---
  const lidTop = Math.max(0, Math.min(1.25, (p.lidTop ?? 0) + (p.blink ?? 0)));
  for (const side of [-1, 1]) {
    const cx = 100 + side * FACE.EYE_DX;
    const cy = FACE.EYE_Y;
    const r = FACE.EYE_R * (side > 0 ? 1 - (p.eyeAsym ?? 0) : 1);

    ctx.save();
    // Lid closure clips the circle from above.
    const openTop = cy - r + lidTop * 2 * r;
    ctx.beginPath();
    ctx.rect(cx - r - 2, openTop, r * 2 + 4, cy + r + 2 - openTop);
    ctx.clip();

    const g = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.3, 0, cx, cy, r);
    g.addColorStop(0, '#fff');
    g.addColorStop(0.72, '#fff');
    g.addColorStop(1, '#FFE0A8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // A shut eye is a drawn line, not an absence.
    const shut = Math.max(0, Math.min(1, (lidTop - 0.72) / 0.28));
    if (shut > 0.01) {
      ctx.strokeStyle = `rgba(255,255,255,${shut.toFixed(3)})`;
      ctx.lineWidth = Math.max(3.5, r * 0.34);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - 1);
      ctx.quadraticCurveTo(cx, cy + r * 0.7, cx + r, cy - 1);
      ctx.stroke();
    }
  }

  // --- mouth: filled AND stroked, so the outline is always round ---
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 8;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  mouthPath(ctx, 100, FACE.MOUTH_Y, p.mouthW ?? 1, p.mouthOpen ?? 0.5, p.mouthCurve ?? 0.8, p.mouthWave ?? 0);
  ctx.fill();
  ctx.stroke();
}
