'use strict';
/**
 * fren's face — an expressive, spring-driven character.
 *
 * Every emotion is a point in one shared parameter space, so any emotion can
 * blend into any other: the springs do the interpolation, which is what makes
 * the motion feel alive rather than switched. Nothing here knows about the app;
 * it only knows how to feel.
 */
(function (global) {
  // ---------------------------------------------------------------- palette
  const CREAM = [240, 231, 214];
  const CREAM_DEEP = [201, 186, 160];
  const ORANGE_LITE = [249, 183, 101];
  const ORANGE = [237, 138, 47];
  const ORANGE_DEEP = [196, 92, 24];
  const BONE = [251, 246, 236];
  const TAN = [166, 143, 110];   // features on the cream (private) face

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const mixRGB = (a, b, t) =>
    `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;

  // ------------------------------------------------------------- parameters
  // warm     0 = cream & private, 1 = orange & awake
  // eyeR     eye radius scale
  // lidTop   upper lid descent   (1 = shut)
  // lidBot   lower lid rise      (creates the happy ^^ crescent)
  // lidCurve curvature of the lower lid edge
  // lookX/Y  gaze offset
  // mouthW   mouth width scale
  // mouthOpen how far the jaw drops
  // mouthCurve 1 = full smile, 0 = flat, -1 = frown
  // tilt     head tilt in degrees
  // bob      vertical offset
  // squash   +squat / -stretch
  // glow     ambient light spill
  const NEUTRAL = {
    warm: 1, eyeR: 1, lidTop: 0, lidBot: 0, lidCurve: 0,
    lookX: 0, lookY: 0, mouthW: 1, mouthOpen: 0.34, mouthCurve: 1,
    tilt: 0, bob: 0, squash: 0, glow: 0.5,
  };

  const E = (o) => Object.assign({}, NEUTRAL, o);

  const EMOTIONS = {
    // — privacy states: the whole character goes cream when it isn't looking —
    private:   E({ warm: 0, lidTop: 0.94, lidCurve: 0.55, mouthOpen: 0.13, mouthW: 0.66, mouthCurve: 0.85, glow: 0.12 }),
    sleeping:  E({ warm: 0, lidTop: 0.97, lidCurve: 0.6, mouthOpen: 0.1, mouthW: 0.5, mouthCurve: 0.7, glow: 0.08, bob: 1.2 }),
    waking:    E({ warm: 0.5, lidTop: 0.4, eyeR: 1.06, mouthOpen: 0.3, glow: 0.35 }),

    // — awake & working —
    neutral:   E({}),
    watching:  E({ eyeR: 1.06, mouthOpen: 0.42, mouthW: 1.05, glow: 0.6 }),
    listening: E({ eyeR: 1.1, mouthOpen: 0.2, mouthW: 0.8, tilt: -5, glow: 0.62 }),
    thinking:  E({ eyeR: 0.86, lidTop: 0.3, lookX: 0.55, lookY: -0.5, mouthOpen: 0.12, mouthW: 0.52, mouthCurve: 0.2, tilt: 4, glow: 0.5 }),
    processing:E({ eyeR: 0.7, lidTop: 0.36, mouthOpen: 0.1, mouthW: 0.46, mouthCurve: 0, glow: 0.45 }),
    talking:   E({ eyeR: 1.04, mouthOpen: 0.6, mouthW: 0.95, glow: 0.62 }),

    // — the good feelings —
    happy:     E({ lidBot: 0.52, lidCurve: 1, mouthOpen: 0.5, mouthW: 1.1, glow: 0.72 }),
    delighted: E({ lidBot: 0.6, lidCurve: 1, mouthOpen: 0.78, mouthW: 1.2, bob: -2.5, squash: -0.06, glow: 0.85 }),
    idea:      E({ eyeR: 1.28, lidTop: -0.12, mouthOpen: 0.66, mouthW: 1.12, bob: -3.5, squash: -0.08, glow: 1 }),
    proud:     E({ lidBot: 0.45, lidCurve: 0.9, mouthOpen: 0.26, mouthW: 0.76, lookY: -0.2, tilt: -6, glow: 0.7 }),
    love:      E({ lidBot: 0.58, lidCurve: 1, mouthOpen: 0.56, mouthW: 1.06, squash: 0.05, glow: 0.9 }),
    mischief:  E({ lidBot: 0.5, lidCurve: 0.8, mouthOpen: 0.3, mouthW: 0.9, mouthCurve: 0.75, tilt: -8, lookX: 0.35, glow: 0.7 }),

    // — the rest of the range —
    curious:   E({ eyeR: 1.16, lookX: 0.4, mouthOpen: 0.24, mouthW: 0.5, mouthCurve: 0.5, tilt: -9, glow: 0.66 }),
    surprised: E({ eyeR: 1.4, lidTop: -0.18, mouthOpen: 0.82, mouthW: 0.46, mouthCurve: 0, bob: -2, squash: -0.1, glow: 0.8 }),
    confused:  E({ eyeR: 0.94, lidTop: 0.22, lookX: -0.3, mouthOpen: 0.2, mouthW: 0.62, mouthCurve: -0.35, tilt: 10, glow: 0.5 }),
    concerned: E({ eyeR: 1.02, lidTop: 0.16, mouthOpen: 0.2, mouthW: 0.72, mouthCurve: -0.6, glow: 0.42 }),
    sad:       E({ eyeR: 0.96, lidTop: 0.34, lookY: 0.45, mouthOpen: 0.18, mouthW: 0.66, mouthCurve: -0.85, bob: 2.2, squash: 0.07, glow: 0.28 }),
    bored:     E({ eyeR: 0.9, lidTop: 0.52, lookX: -0.5, lookY: 0.15, mouthOpen: 0.12, mouthW: 0.6, mouthCurve: -0.1, glow: 0.35 }),
    oops:      E({ eyeR: 1.2, lidTop: -0.05, mouthOpen: 0.3, mouthW: 1.14, mouthCurve: -0.2, tilt: 6, glow: 0.55 }),
  };

  const ORDER = [
    'private', 'sleeping', 'waking', 'neutral', 'watching', 'listening',
    'thinking', 'processing', 'talking', 'happy', 'delighted', 'idea',
    'proud', 'love', 'mischief', 'curious', 'surprised', 'confused',
    'concerned', 'sad', 'bored', 'oops',
  ];

  // Springs: stiffness / damping per parameter. Gaze and lids are quick,
  // the body is looser so it trails slightly — that lag reads as weight.
  const SPRING = {
    _default: [150, 15],
    lidTop: [320, 24], lidBot: [260, 22], lookX: [200, 20], lookY: [200, 20],
    mouthOpen: [240, 20], bob: [120, 12], squash: [180, 14], tilt: [120, 13],
    warm: [60, 16], glow: [70, 14], eyeR: [220, 18],
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  let uid = 0;

  class Face {
    constructor(mount, opts = {}) {
      this.reduced =
        global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.id = 'fren' + ++uid;
      this.p = Object.assign({}, NEUTRAL);        // current values
      this.target = Object.assign({}, NEUTRAL);   // where we're heading
      this.v = {};                                // velocities
      for (const k in this.p) this.v[k] = 0;

      this.emotion = 'neutral';
      this.t = 0;
      this.nextBlink = 1.5;
      this.blink = 0;
      this.nextGlance = 3;
      this.glance = { x: 0, y: 0 };
      this.talkPhase = -1;   // >=0 while speaking
      this.particles = [];
      this.nextParticle = 0;

      this._build(mount, opts.size || 200);
      this._loop = this._loop.bind(this);
      this.last = 0;
      requestAnimationFrame(this._loop);
    }

    _build(mount, size) {
      const id = this.id;
      const svg = el('svg', {
        viewBox: '0 0 200 200', width: size, height: size, class: 'fren-face',
      });
      svg.innerHTML = `
        <defs>
          <radialGradient id="${id}-visor" cx="34%" cy="26%" r="78%">
            <stop offset="0%"   stop-color="#F9B765"/>
            <stop offset="52%"  stop-color="#ED8A2F"/>
            <stop offset="100%" stop-color="#C45C18"/>
          </radialGradient>
          <radialGradient id="${id}-shell" cx="36%" cy="24%" r="82%">
            <stop offset="0%"   stop-color="#FBF6EC"/>
            <stop offset="60%"  stop-color="#EFE5D2"/>
            <stop offset="100%" stop-color="#C9BAA0"/>
          </radialGradient>
          <linearGradient id="${id}-gloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#fff" stop-opacity=".72"/>
            <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
          </linearGradient>
          <radialGradient id="${id}-glow">
            <stop offset="0%"   stop-color="#ED8A2F" stop-opacity=".55"/>
            <stop offset="100%" stop-color="#ED8A2F" stop-opacity="0"/>
          </radialGradient>
          <clipPath id="${id}-visorClip"><circle cx="100" cy="94" r="68"/></clipPath>
          <mask id="${id}-eyeL"><ellipse fill="#fff"/><path fill="#000"/><path fill="#000"/></mask>
          <mask id="${id}-eyeR"><ellipse fill="#fff"/><path fill="#000"/><path fill="#000"/></mask>
        </defs>
        <ellipse class="glow"/>
        <g class="body">
          <circle class="shell"/>
          <circle class="visor"/>
          <ellipse class="gloss" fill="url(#${id}-gloss)" clip-path="url(#${id}-visorClip)"/>
          <g class="features">
            <rect class="eye eyeL" mask="url(#${id}-eyeL)"/>
            <rect class="eye eyeR" mask="url(#${id}-eyeR)"/>
            <path class="lidLine lidLineL" fill="none" stroke-linecap="round"/>
            <path class="lidLine lidLineR" fill="none" stroke-linecap="round"/>
            <path class="mouth"/>
          </g>
        </g>
        <g class="fx"></g>`;
      mount.appendChild(svg);

      const q = (s) => svg.querySelector(s);
      this.svg = svg;
      this.g = {
        glow: q('.glow'), body: q('.body'), shell: q('.shell'), visor: q('.visor'),
        gloss: q('.gloss'), eyeL: q('.eyeL'), eyeR: q('.eyeR'), mouth: q('.mouth'),
        lidLineL: q('.lidLineL'), lidLineR: q('.lidLineR'),
        fx: q('.fx'),
        maskL: svg.querySelectorAll(`#${id}-eyeL > *`),
        maskR: svg.querySelectorAll(`#${id}-eyeR > *`),
        visorStops: svg.querySelectorAll(`#${id}-visor stop`),
      };
    }

    /** Move toward an emotion. Springs handle the transition. */
    set(name, opts = {}) {
      const preset = EMOTIONS[name];
      if (!preset) return;
      this.emotion = name;
      Object.assign(this.target, preset, opts.override || {});
      if (opts.immediate) {
        Object.assign(this.p, this.target);
        for (const k in this.v) this.v[k] = 0;
      }
    }

    /** Animate the mouth as if speaking; call stopTalking() when done. */
    startTalking() { this.talkPhase = 0; }
    stopTalking() { this.talkPhase = -1; }

    /** A one-shot physical reaction — the character reacts, then settles. */
    pulse(kind = 'bounce') {
      if (this.reduced) return;
      if (kind === 'bounce') { this.v.bob -= 190; this.v.squash -= 3.2; }
      if (kind === 'nod')    { this.v.tilt += 130; }
      if (kind === 'shake')  { this.v.tilt -= 190; }
      if (kind === 'blink')  { this.blink = 1; }
    }

    _spring(k, dt) {
      const [stiff, damp] = SPRING[k] || SPRING._default;
      const a = (this.target[k] - this.p[k]) * stiff - this.v[k] * damp;
      this.v[k] += a * dt;
      this.p[k] += this.v[k] * dt;
    }

    _loop(now) {
      const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
      this.last = now;
      this.t += dt;
      for (const k in this.p) this._spring(k, dt);
      this._idle(dt);
      this._draw();
      requestAnimationFrame(this._loop);
    }

    /** Involuntary life: breathing, blinking, wandering gaze, particles. */
    _idle(dt) {
      if (this.reduced) return;
      const awake = this.target.warm > 0.5;

      // Blink — never while the eyes are already shut.
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && awake && this.target.lidTop < 0.5) {
        this.blink = 1;
        this.nextBlink = 2.2 + Math.random() * 4;
      }
      if (this.blink > 0) this.blink = Math.max(0, this.blink - dt * 7.5);

      // Idle glances, only when the emotion hasn't pinned the gaze.
      this.nextGlance -= dt;
      if (this.nextGlance <= 0) {
        const still = Math.abs(this.target.lookX) < 0.05 && Math.abs(this.target.lookY) < 0.05;
        this.glance = still && awake && Math.random() > 0.35
          ? { x: (Math.random() - 0.5) * 0.7, y: (Math.random() - 0.5) * 0.4 }
          : { x: 0, y: 0 };
        this.nextGlance = 1.4 + Math.random() * 3.4;
      }

      if (this.talkPhase >= 0) this.talkPhase += dt;
      this._spawnParticles(dt);
    }

    _spawnParticles(dt) {
      const kind = this.emotion === 'sleeping' ? 'z'
        : this.emotion === 'idea' ? 'spark'
        : this.emotion === 'love' ? 'heart' : null;
      this.nextParticle -= dt;
      if (kind && this.nextParticle <= 0) {
        this.particles.push({ kind, life: 0, max: kind === 'z' ? 2.8 : 1.1, x: (Math.random() - 0.5) * 26 });
        this.nextParticle = kind === 'z' ? 1.5 : 0.26;
      }
      for (const p of this.particles) p.life += dt;
      this.particles = this.particles.filter((p) => p.life < p.max);
    }

    _draw() {
      const p = this.p;
      const g = this.g;
      const breathe = this.reduced ? 0 : Math.sin(this.t * 1.5) * 1.1;
      const drift = this.reduced ? 0 : Math.sin(this.t * 0.7) * 0.9;

      // Body transform: bob, squash & stretch, tilt.
      const sq = 1 + p.squash;
      const cy = 100 + p.bob + breathe;
      g.body.setAttribute(
        'transform',
        `translate(100 ${cy}) rotate(${p.tilt + drift}) scale(${1 / sq} ${sq}) translate(-100 -100)`
      );

      // Shell (cream cradle) sits a touch lower than the visor, so a crescent
      // of it shows at the bottom — the character rests in its own shell.
      g.shell.setAttribute('cx', 100);
      g.shell.setAttribute('cy', 108);
      g.shell.setAttribute('r', 76);
      g.shell.setAttribute('fill', `url(#${this.id}-shell)`);

      // Visor colour crossfades cream -> orange with `warm`.
      const w = clamp(p.warm, 0, 1);
      const stops = g.visorStops;
      stops[0].setAttribute('stop-color', mixRGB(CREAM, ORANGE_LITE, w));
      stops[1].setAttribute('stop-color', mixRGB([233, 223, 203], ORANGE, w));
      stops[2].setAttribute('stop-color', mixRGB(CREAM_DEEP, ORANGE_DEEP, w));
      g.visor.setAttribute('cx', 100);
      g.visor.setAttribute('cy', 94);
      g.visor.setAttribute('r', 68);
      g.visor.setAttribute('fill', `url(#${this.id}-visor)`);

      g.gloss.setAttribute('cx', 79);
      g.gloss.setAttribute('cy', 52);
      g.gloss.setAttribute('rx', 38);
      g.gloss.setAttribute('ry', 24);
      g.gloss.setAttribute('transform', 'rotate(-18 79 52)');

      // Warm light spilling onto whatever is behind the orb.
      g.glow.setAttribute('cx', 100);
      g.glow.setAttribute('cy', 112);
      g.glow.setAttribute('rx', 96);
      g.glow.setAttribute('ry', 88);
      g.glow.setAttribute('fill', `url(#${this.id}-glow)`);
      g.glow.setAttribute('opacity', (clamp(p.glow, 0, 1) * 0.85 * w).toFixed(3));

      // ---- eyes ----
      const lookX = (p.lookX + this.glance.x) * 7;
      const lookY = (p.lookY + this.glance.y) * 5;
      const r = 16 * clamp(p.eyeR, 0.2, 2);
      const lidTop = clamp(p.lidTop + this.blink, 0, 1.25);
      const feature = mixRGB(TAN, BONE, w);
      const shutness = clamp((lidTop - 0.72) / 0.28, 0, 1);
      this._eye(g.eyeL, this.g.maskL, g.lidLineL, 70 + lookX, 86 + lookY, r, lidTop, p.lidBot, p.lidCurve, feature, shutness);
      this._eye(g.eyeR, this.g.maskR, g.lidLineR, 130 + lookX, 86 + lookY, r, lidTop, p.lidBot, p.lidCurve, feature, shutness);

      // ---- mouth ----
      let open = clamp(p.mouthOpen, 0, 1);
      if (this.talkPhase >= 0) {
        // Two detuned sines: speech-like, never a metronome.
        const s = Math.sin(this.talkPhase * 15) * 0.5 + Math.sin(this.talkPhase * 23.7) * 0.3;
        open = clamp(0.42 + s * 0.34, 0.08, 1);
      }
      g.mouth.setAttribute('d', this._mouthPath(100 + lookX * 0.5, 122 + lookY * 0.4, p.mouthW, open, p.mouthCurve));
      g.mouth.setAttribute('fill', feature);

      this._drawParticles();
    }

    _eye(rect, mask, lidLine, cx, cy, r, lidTop, lidBot, lidCurve, color, shutness) {
      const pad = r + 6;
      rect.setAttribute('x', cx - pad);
      rect.setAttribute('y', cy - pad);
      rect.setAttribute('width', pad * 2);
      rect.setAttribute('height', pad * 2);
      rect.setAttribute('fill', color);

      const [ellipse, top, bottom] = mask;
      ellipse.setAttribute('cx', cx);
      ellipse.setAttribute('cy', cy);
      ellipse.setAttribute('rx', r);
      ellipse.setAttribute('ry', r);

      // Upper lid slides down; a shut eye is the lid meeting the bottom.
      // The lid's lower edge bows *down*; a straight cut reads as a scowl.
      const ty = cy - r - 2 + lidTop * (2 * r + 4);
      top.setAttribute('d', `M${cx - pad} ${cy - pad} H${cx + pad} V${ty} Q${cx} ${ty + 5} ${cx - pad} ${ty} Z`);

      // A shut eye is a drawn line, not an absence — otherwise the private
      // (cream-on-cream) face loses its features entirely.
      lidLine.setAttribute('opacity', shutness.toFixed(3));
      lidLine.setAttribute('stroke', color);
      lidLine.setAttribute('stroke-width', Math.max(3, r * 0.3).toFixed(1));
      lidLine.setAttribute('d', `M${cx - r * 0.92} ${cy - 1} Q${cx} ${cy + r * 0.62} ${cx + r * 0.92} ${cy - 1}`);

      // Lower lid rises with a convex edge — that curve is what makes a smile
      // reach the eyes as a ^^ crescent.
      const by = cy + r + 2 - lidBot * (2 * r + 4);
      const bulge = by - lidCurve * r * 0.95;
      bottom.setAttribute('d', `M${cx - pad} ${cy + pad} H${cx + pad} V${by} Q${cx} ${bulge} ${cx - pad} ${by} Z`);
    }

    /**
     * One path, three feelings: width, openness, curve.
     * Flat top + deep bottom arc is the signature half-disc grin; invert the
     * curve for a frown, meet the edges for a line, part them for speech.
     */
    _mouthPath(cx, cy, wScale, open, curve) {
      const w = 32 * clamp(wScale, 0.2, 1.6);
      const c = clamp(curve, -1, 1);
      const depth = 8 + open * 30;
      // Control offsets are doubled: a quadratic only reaches half of them.
      const topBow = c > 0 ? -open * 4 : -c * 26 - open * 7;
      const botBow = c > 0 ? depth * (0.95 + c * 1.35) : depth * 0.9 - c * 18;
      const lift = c < 0 ? -c * 5 : 0;
      return `M${cx - w} ${cy + lift} Q${cx} ${cy + topBow + lift} ${cx + w} ${cy + lift}` +
             ` Q${cx} ${cy + botBow + lift} ${cx - w} ${cy + lift} Z`;
    }

    _drawParticles() {
      const fx = this.g.fx;
      while (fx.firstChild) fx.removeChild(fx.firstChild);
      for (const p of this.particles) {
        const k = p.life / p.max;
        const y = 62 - k * 46;
        const o = Math.sin(k * Math.PI);
        if (p.kind === 'z') {
          const t = el('text', {
            x: 140 + p.x + k * 12, y, fill: 'var(--cream, #F0E7D6)', opacity: (o * 0.9).toFixed(2),
            'font-size': 16 + k * 10, 'font-family': 'var(--font, sans-serif)', 'font-weight': 700,
          });
          t.textContent = 'z';
          fx.appendChild(t);
        } else {
          const size = p.kind === 'heart' ? 7 : 5;
          fx.appendChild(el('circle', {
            cx: 100 + p.x + (p.kind === 'spark' ? Math.sin(k * 6) * 10 : 0),
            cy: y, r: size * (1 - k * 0.4),
            fill: p.kind === 'heart' ? '#F2748C' : 'var(--orange-lite, #F9B765)',
            opacity: (o * 0.95).toFixed(2),
          }));
        }
      }
    }
  }

  global.FrenFace = { Face, EMOTIONS, ORDER };
})(window);
