'use strict';
/**
 * fren's face, drawn to a canvas so it can be used as an emissive texture.
 *
 * Tuned for an ASSISTANT rather than a cartoon. Cuteness here comes from
 * PROPORTION, not amplitude: large round eyes set wide and low, and a small
 * mouth. That combination reads as friendly at rest, which means the
 * expressions never have to shout to be legible. A wide grin on something
 * that sits on your desktop all day stops looking friendly and starts
 * looking manic, so the mouth stays small and the range stays narrow.
 *
 * The light is layered the way a warm source actually photographs: a blown
 * white core falling off through amber into the material around it. On an
 * emissive map that spill is what makes the features read as lit from inside
 * the sphere instead of painted onto it.
 */

export const FACE = {
  EYE_DX: 38,      // wide-set: baby schema, and it leaves the mouth room
  EYE_Y: 90,       // slightly below centre, which reads younger and softer
  EYE_R: 15.2,     // steady: oversized eyes read glazed, not alert
  MOUTH_Y: 128,
  MOUTH_W: 32,     // still small next to the eyes: that ratio is the sobriety
};

/** Warm falloff, widest and dimmest first. Radii are in face units. */
const GLOW = [
  { blur: 12.0, alpha: 0.30, color: '#FF7A00' },   // far spill, material hue
  { blur: 7.5,  alpha: 0.34, color: '#FF8A00' },
  { blur: 4.4,  alpha: 0.38, color: '#FFB14A' },   // halo, full amber
  { blur: 2.5,  alpha: 0.42, color: '#FFD08A' },
  { blur: 1.2,  alpha: 0.46, color: '#FFE9C4' },   // bloom, warm white
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The mouth. One path, filled AND stroked with round joins, so the outline
 * can never come to a point -- a triangular mouth is the failure mode this
 * construction exists to prevent.
 *
 * Control points sit near the corners so the sides stay vertical and the
 * bottom stays round. Pull them inward and it becomes a wedge.
 */
function mouthPath(ctx, cx, cy, wScale, open, curve, wave) {
  const w = FACE.MOUTH_W * clamp(wScale, 0.1, 1.6);
  const c = clamp(curve, -1, 1);
  const kx = w * 0.94;
  const lip = c * 5.0;                    // half the old lift: gentler curve
  const drop = open * (7 + w * 0.42);     // and a shallower opening
  const top = lip - drop * 0.1;
  const bot = lip + drop;
  const k = 1.3333;
  const s = wave * 4;

  ctx.beginPath();
  ctx.moveTo(cx - w, cy);
  ctx.bezierCurveTo(cx - kx, cy + top * k + s, cx + kx, cy + top * k - s, cx + w, cy);
  ctx.bezierCurveTo(cx + kx, cy + bot * k - s, cx - kx, cy + bot * k + s, cx - w, cy);
  ctx.closePath();
}

/** A closed, resting smile: a stroked arc, no cavity. */
function smileArc(ctx, cx, cy, wScale, curve) {
  const w = FACE.MOUTH_W * clamp(wScale, 0.1, 1.6);
  const c = clamp(curve, -1, 1);
  ctx.beginPath();
  ctx.moveTo(cx - w, cy - c * 1.5);
  ctx.quadraticCurveTo(cx, cy + c * 9.0, cx + w, cy - c * 1.5);
}

/**
 * Draw the eyes and mouth once, in one flat colour. Called repeatedly at
 * different blur radii to build the falloff, then once sharp for the core.
 */
function paintFeatures(ctx, p, style, lineScale) {
  const lidTop = clamp((p.lidTop ?? 0) + (p.blink ?? 0), 0, 1.25);
  const open = clamp(p.mouthOpen ?? 0, 0, 1);

  ctx.fillStyle = style;
  ctx.strokeStyle = style;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // --- eyes -----------------------------------------------------------------
  for (const side of [-1, 1]) {
    const cx = 100 + side * FACE.EYE_DX;
    const cy = FACE.EYE_Y;
    const r = FACE.EYE_R * (p.eyeScale ?? 1) * (side > 0 ? 1 - (p.eyeAsym ?? 0) : 1);
    const lid = clamp(lidTop, 0, 1);

    ctx.beginPath();
    if (lid <= 0.005) {
      // Fully open. A touch taller than wide -- barely measurable, reliably
      // cuter.
      ctx.ellipse(cx, cy, r, r * 1.06, 0, 0, Math.PI * 2);
    } else {
      // The lid crosses the circle at a chord; what remains below it is the
      // visible eye. SLIVER is the thickness left when fully shut, so the
      // shape becomes a curved closed lid instead of disappearing -- which is
      // what lets one shape cover the whole range.
      const SLIVER = r * 0.38;
      const openTop = cy - r + lid * (2 * r - SLIVER);
      const dy = openTop - cy;
      const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
      ctx.moveTo(cx - dx, openTop);
      // A slight downward bow on the lid line, so a nearly-shut eye reads as
      // a relaxed lid rather than a ruled edge.
      ctx.quadraticCurveTo(cx, openTop + r * 0.10 * lid, cx + dx, openTop);
      ctx.arc(cx, cy, r, Math.atan2(dy, dx), Math.atan2(dy, -dx), false);
      ctx.closePath();
    }
    ctx.fill();
  }

  // --- mouth ----------------------------------------------------------------
  // Below a threshold there is no cavity to draw: a resting mouth is a line,
  // which is what keeps the neutral face calm instead of gormlessly agape.
  // Thinking: the mouth gives way to three beads that light up in turn, an
  // ellipsis said with the face. Cross-faded on `dots`, so it arrives and
  // leaves the way every other feature does.
  const dots = clamp(p.dots ?? 0, 0, 1);
  const alpha = ctx.globalAlpha;
  if (dots < 0.995) {
    ctx.globalAlpha = alpha * (1 - dots);
    if (open < 0.07) {
      ctx.lineWidth = 7.8 * lineScale;
      smileArc(ctx, 100, FACE.MOUTH_Y, p.mouthW ?? 1, p.mouthCurve ?? 0.8);
      ctx.stroke();
    } else {
      ctx.lineWidth = 7.0 * lineScale;
      mouthPath(ctx, 100, FACE.MOUTH_Y, p.mouthW ?? 1, open,
                p.mouthCurve ?? 0.8, p.mouthWave ?? 0);
      ctx.fill();
      ctx.stroke();
    }
  }
  if (dots > 0.005) {
    const phase = p.dotPhase ?? 0;
    for (let i = 0; i < 3; i += 1) {
      const wave = 0.5 + 0.5 * Math.sin(phase * 5.4 - i * 1.3);
      ctx.globalAlpha = alpha * dots * (0.22 + 0.78 * wave);
      ctx.beginPath();
      ctx.arc(100 + (i - 1) * 19, FACE.MOUTH_Y + 1, 4.6 + wave * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = alpha;
}

/**
 * Paint the face into a canvas. `p` uses the same parameter names as the SVG
 * renderer, so one spring system can drive either.
 */
export function drawFace(canvas, p) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width / 200;          // the face lives in a 200-unit box
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // OPAQUE BLACK, not clear. This canvas becomes an emissive map, and an
  // emissive map is sampled for RGB with the alpha channel discarded -- so a
  // glow pixel at 5% alpha would read as FULL brightness, turning the whole
  // falloff into a flat plateau with a hard edge. Compositing onto black
  // bakes the alpha into the colour, which is what makes the gradient survive.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(S, 0, 0, S, 0, (canvas.height - 200 * S) / 2);

  const lit = clamp(p.lit ?? 1, 0, 1);
  if (lit < 0.05) return;                // light off: nothing emits, ever

  // Additive, so each pass adds light rather than covering the one beneath.
  ctx.globalCompositeOperation = 'lighter';

  for (const g of GLOW) {
    ctx.save();
    // Canvas filters work in device pixels, so the radius has to be scaled
    // out of face units or the blur changes size with the texture.
    ctx.filter = `blur(${(g.blur * S).toFixed(2)}px)`;
    ctx.globalAlpha = g.alpha * lit;
    paintFeatures(ctx, p, g.color, 1);
    ctx.restore();
  }

  // The crisp core last, on top, so the silhouette still reads sharply
  // through all that bloom.
  ctx.save();
  ctx.filter = 'none';
  ctx.globalAlpha = 0.86 * lit;
  paintFeatures(ctx, p, '#FFFFFF', 1);
  ctx.restore();

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}
