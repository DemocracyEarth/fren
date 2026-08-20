'use strict';
/**
 * fren's face — one clean sphere, lit from within.
 *
 * The features are not drawn *on* the sphere; they are light *inside* it, so
 * they bloom and sit under the same highlight as the surface. Feeling is
 * carried by the sphere's own colour: a warm skin tone at rest, shifting hue
 * with the emotion. When fren isn't watching, the light simply goes out —
 * which is the privacy signal, and it is unmistakable.
 *
 * Every emotion is a point in one shared parameter space, and each parameter
 * is driven by its own spring, so any emotion blends into any other.
 */
(function (global) {
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const hsl = (h, s, l) =>
    `hsl(${h.toFixed(1)} ${(clamp(s, 0, 1) * 100).toFixed(1)}% ${(clamp(l, 0, 1) * 100).toFixed(1)}%)`;

  // ------------------------------------------------------------- parameters
  // hue/sat/lum  the sphere's own colour — this is where the feeling lives
  // lit          how strongly the face glows from inside (0 = light off)
  // eyeR         eye size
  // lidTop/Bot   lid coverage from above / below (lidBot makes the ^^ crescent)
  // lidCurve     curvature of the lower lid edge
  // lidTilt      lid angle, mirrored across the face: + droops the outer
  //              corner (sad, sleepy), - drops the inner one (angry, smug)
  // lookX/Y      gaze
  // mouthW/Open/Curve   width, jaw drop, and smile(+1) .. flat(0) .. frown(-1)
  // tilt/bob/squash     head tilt, vertical offset, squash & stretch
  // glow         ambient light spilling behind the sphere
  const NEUTRAL = {
    hue: 26, sat: 0.6, lum: 0.62, lit: 1,
    eyeR: 1, lidTop: 0, lidBot: 0, lidCurve: 0, lidTilt: 0,
    lookX: 0, lookY: 0,
    mouthW: 1, mouthOpen: 0.34, mouthCurve: 1,
    tilt: 0, bob: 0, squash: 0, glow: 0.5,
  };

  const E = (o) => Object.assign({}, NEUTRAL, o);

  const EMOTIONS = {
    // — not watching: the light is out, and the colour drains with it —
    private:   E({ hue: 26, sat: 0.16, lum: 0.44, lit: 0.05, lidTop: 0.94, lidCurve: 0.55, lidTilt: 0.3,
                   mouthOpen: 0.12, mouthW: 0.62, mouthCurve: 0.85, glow: 0.06 }),
    sleeping:  E({ hue: 26, sat: 0.13, lum: 0.4, lit: 0.03, lidTop: 0.97, lidCurve: 0.6, lidTilt: 0.32,
                   mouthOpen: 0.1, mouthW: 0.5, mouthCurve: 0.7, glow: 0.04, bob: 1.2 }),
    waking:    E({ hue: 26, sat: 0.42, lum: 0.56, lit: 0.55, lidTop: 0.38, lidTilt: 0.2, eyeR: 1.04,
                   mouthOpen: 0.28, glow: 0.3 }),

    // — awake and working: warm skin tone, cooling as it concentrates —
    neutral:   E({}),
    watching:  E({ hue: 28, sat: 0.66, lum: 0.63, eyeR: 1.06, mouthOpen: 0.42, mouthW: 1.05, glow: 0.6 }),
    listening: E({ hue: 30, sat: 0.6, lum: 0.63, eyeR: 1.1, mouthOpen: 0.2, mouthW: 0.8, tilt: -5, glow: 0.62 }),
    thinking:  E({ hue: 208, sat: 0.4, lum: 0.58, eyeR: 0.86, lidTop: 0.3, lidTilt: 0.12,
                   lookX: 0.55, lookY: -0.5, mouthOpen: 0.12, mouthW: 0.52, mouthCurve: 0.2, tilt: 4, glow: 0.5 }),
    processing:E({ hue: 202, sat: 0.36, lum: 0.56, eyeR: 0.7, lidTop: 0.36,
                   mouthOpen: 0.1, mouthW: 0.46, mouthCurve: 0, glow: 0.45 }),
    talking:   E({ hue: 28, sat: 0.64, lum: 0.63, eyeR: 1.04, mouthOpen: 0.6, mouthW: 0.95, glow: 0.62 }),

    // — the good feelings: warmer, brighter, more saturated —
    happy:     E({ hue: 34, sat: 0.76, lum: 0.64, lidBot: 0.52, lidCurve: 1, mouthOpen: 0.5, mouthW: 1.1, glow: 0.74 }),
    delighted: E({ hue: 38, sat: 0.84, lum: 0.66, lidBot: 0.6, lidCurve: 1, mouthOpen: 0.78, mouthW: 1.2,
                   bob: -2.5, squash: -0.06, glow: 0.88 }),
    idea:      E({ hue: 46, sat: 0.92, lum: 0.68, lit: 1.15, eyeR: 1.28, lidTop: -0.12,
                   mouthOpen: 0.66, mouthW: 1.12, bob: -3.5, squash: -0.08, glow: 1 }),
    proud:     E({ hue: 32, sat: 0.72, lum: 0.64, lidBot: 0.45, lidCurve: 0.9, lidTilt: -0.2,
                   mouthOpen: 0.26, mouthW: 0.76, lookY: -0.2, tilt: -6, glow: 0.72 }),
    love:      E({ hue: 348, sat: 0.66, lum: 0.66, lidBot: 0.58, lidCurve: 1,
                   mouthOpen: 0.56, mouthW: 1.06, squash: 0.05, glow: 0.9 }),
    mischief:  E({ hue: 292, sat: 0.4, lum: 0.62, lidBot: 0.5, lidCurve: 0.8, lidTilt: -0.15,
                   mouthOpen: 0.3, mouthW: 0.9, mouthCurve: 0.75, tilt: -8, lookX: 0.35, glow: 0.72 }),

    // — the rest of the range —
    curious:   E({ hue: 40, sat: 0.6, lum: 0.64, eyeR: 1.16, lookX: 0.4,
                   mouthOpen: 0.24, mouthW: 0.5, mouthCurve: 0.5, tilt: -9, glow: 0.66 }),
    surprised: E({ hue: 48, sat: 0.78, lum: 0.68, eyeR: 1.4, lidTop: -0.18,
                   mouthOpen: 0.82, mouthW: 0.46, mouthCurve: 0, bob: -2, squash: -0.1, glow: 0.82 }),
    confused:  E({ hue: 262, sat: 0.34, lum: 0.58, eyeR: 0.94, lidTop: 0.22, lidTilt: 0.25, lookX: -0.3,
                   mouthOpen: 0.2, mouthW: 0.62, mouthCurve: -0.35, tilt: 10, glow: 0.5 }),
    concerned: E({ hue: 14, sat: 0.46, lum: 0.56, eyeR: 1.02, lidTop: 0.16, lidTilt: 0.5,
                   mouthOpen: 0.2, mouthW: 0.72, mouthCurve: -0.6, glow: 0.42 }),
    sad:       E({ hue: 218, sat: 0.42, lum: 0.5, lit: 0.8, eyeR: 0.96, lidTop: 0.34, lidTilt: 0.6, lookY: 0.45,
                   mouthOpen: 0.18, mouthW: 0.66, mouthCurve: -0.85, bob: 2.2, squash: 0.07, glow: 0.26 }),
    bored:     E({ hue: 30, sat: 0.13, lum: 0.52, lit: 0.85, eyeR: 0.9, lidTop: 0.52, lidTilt: 0.35,
                   lookX: -0.5, lookY: 0.15, mouthOpen: 0.12, mouthW: 0.6, mouthCurve: -0.1, glow: 0.3 }),
    oops:      E({ hue: 6, sat: 0.64, lum: 0.6, eyeR: 1.2, lidTop: -0.05,
                   mouthOpen: 0.3, mouthW: 1.14, mouthCurve: -0.2, tilt: 6, glow: 0.58 }),
  };

  const ORDER = [
    'private', 'sleeping', 'waking', 'neutral', 'watching', 'listening',
    'thinking', 'processing', 'talking', 'happy', 'delighted', 'idea',
    'proud', 'love', 'mischief', 'curious', 'surprised', 'confused',
    'concerned', 'sad', 'bored', 'oops',
  ];

  // Gaze and lids are quick; the body is looser so it trails slightly — that
  // lag is what reads as weight. Colour drifts slowest of all.
  const SPRING = {
    _default: [150, 15],
    lidTop: [320, 24], lidBot: [260, 22], lidTilt: [220, 20],
    lookX: [200, 20], lookY: [200, 20],
    mouthOpen: [240, 20], bob: [120, 12], squash: [180, 14], tilt: [120, 13],
    eyeR: [220, 18], glow: [70, 14],
    hue: [55, 15], sat: [70, 17], lum: [70, 17], lit: [90, 18],
  };

  const SPHERE = { cx: 100, cy: 100, r: 74 };
  const EYE = { dx: 30, y: 88, r: 16 };
  const MOUTH_Y = 126;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  let uid = 0;

  class Face {
    constructor(mount, opts = {}) {
      this.motionQuery = global.matchMedia
        ? global.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
      this.reduced = !!(this.motionQuery && this.motionQuery.matches);
      if (this.motionQuery) {
        this._onMotion = (e) => { this.reduced = e.matches; this._wake(); };
        this.motionQuery.addEventListener('change', this._onMotion);
      }

      this.id = 'fren' + ++uid;
      // Start dark and closed. If anything upstream fails, the character must
      // look like it is NOT watching — the safe direction.
      this.p = Object.assign({}, NEUTRAL, EMOTIONS.private);
      this.target = Object.assign({}, NEUTRAL, EMOTIONS.private);
      this.v = {};
      for (const k in this.p) this.v[k] = 0;

      this.emotion = 'private';
      this.t = 0;
      this.nextBlink = 1.5;
      this.blink = 0;
      this.nextGlance = 3;
      this.glance = { x: 0, y: 0 };
      this.talkPhase = -1;
      this.particles = [];
      this.nextParticle = 0;

      this._build(mount, opts.size || 200);
      this._loop = this._loop.bind(this);
      this.last = 0;
      this.raf = null;
      this._wake();
    }

    _build(mount, size) {
      const id = this.id;
      const svg = el('svg', {
        viewBox: '0 0 200 200', width: size, height: size, class: 'fren-face',
        'aria-hidden': 'true', focusable: 'false',
      });
      // The features are `use`d twice — once blurred and screen-blended for the
      // bloom, once crisp on top — so the glow always matches the geometry.
      svg.innerHTML = `
        <defs>
          <radialGradient id="${id}-body" cx="34%" cy="26%" r="76%">
            <stop class="s0" offset="0%"/>
            <stop class="s1" offset="54%"/>
            <stop class="s2" offset="100%"/>
          </radialGradient>
          <radialGradient id="${id}-spec" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#fff" stop-opacity=".85"/>
            <stop offset="60%" stop-color="#fff" stop-opacity=".18"/>
            <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="${id}-rim" cx="50%" cy="50%" r="50%">
            <stop class="r0" offset="0%"/>
            <stop class="r1" offset="100%"/>
          </radialGradient>
          <radialGradient id="${id}-amb">
            <stop class="a0" offset="0%"/>
            <stop class="a1" offset="100%"/>
          </radialGradient>
          <clipPath id="${id}-clip"><circle cx="${SPHERE.cx}" cy="${SPHERE.cy}" r="${SPHERE.r}"/></clipPath>
          <filter id="${id}-bloom" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="4"/>
          </filter>
          <filter id="${id}-haze" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="13"/>
          </filter>
          <radialGradient id="${id}-vig" cx="50%" cy="50%" r="50%">
            <stop offset="55%" stop-color="#000" stop-opacity="0"/>
            <stop class="v1" offset="100%" stop-color="#000"/>
          </radialGradient>
          <mask id="${id}-eyeL"><ellipse fill="#fff"/><path fill="#000"/><path fill="#000"/></mask>
          <mask id="${id}-eyeR"><ellipse fill="#fff"/><path fill="#000"/><path fill="#000"/></mask>
          <g id="${id}-feat" fill="currentColor">
            <rect class="eyeL" mask="url(#${id}-eyeL)"/>
            <rect class="eyeR" mask="url(#${id}-eyeR)"/>
            <path class="lidLineL" fill="none" stroke="currentColor" stroke-linecap="round"/>
            <path class="lidLineR" fill="none" stroke="currentColor" stroke-linecap="round"/>
            <path class="mouth"/>
          </g>
        </defs>
        <ellipse class="amb"/>
        <g class="body" style="isolation:isolate">
          <circle class="sphere"/>
          <g clip-path="url(#${id}-clip)">
            <ellipse class="rim"/>
            <use class="haze" href="#${id}-feat" filter="url(#${id}-haze)" style="mix-blend-mode:screen"/>
            <use class="bloom" href="#${id}-feat" filter="url(#${id}-bloom)" style="mix-blend-mode:screen"/>
            <use class="core" href="#${id}-feat"/>
            <circle class="vig"/>
            <ellipse class="spec"/>
            <ellipse class="hotspot"/>
          </g>
        </g>
        <g class="fx"></g>`;
      mount.appendChild(svg);

      const q = (s) => svg.querySelector(s);
      this.svg = svg;
      this.g = {
        amb: q('.amb'), body: q('.body'), sphere: q('.sphere'), rim: q('.rim'),
        spec: q('.spec'), hotspot: q('.hotspot'), bloom: q('.bloom'), haze: q('.haze'),
        core: q('.core'), vig: q('.vig'), fx: q('.fx'),
        eyeL: q(`#${id}-feat .eyeL`), eyeR: q(`#${id}-feat .eyeR`),
        lidLineL: q(`#${id}-feat .lidLineL`), lidLineR: q(`#${id}-feat .lidLineR`),
        mouth: q(`#${id}-feat .mouth`),
        maskL: svg.querySelectorAll(`#${id}-eyeL > *`),
        maskR: svg.querySelectorAll(`#${id}-eyeR > *`),
        s0: q(`#${id}-body .s0`), s1: q(`#${id}-body .s1`), s2: q(`#${id}-body .s2`),
        r0: q(`#${id}-rim .r0`), r1: q(`#${id}-rim .r1`),
        a0: q(`#${id}-amb .a0`), a1: q(`#${id}-amb .a1`), v1: q(`#${id}-vig .v1`),
      };

      // Geometry that never changes is written once, not every frame.
      const set = (node, attrs) => { for (const k in attrs) node.setAttribute(k, attrs[k]); };
      set(this.g.sphere, { ...SPHERE, fill: `url(#${id}-body)` });
      set(this.g.spec, { cx: 73, cy: 54, rx: 27, ry: 18, transform: 'rotate(-22 73 54)', fill: `url(#${id}-spec)` });
      set(this.g.hotspot, { cx: 69, cy: 48, rx: 9, ry: 6, transform: 'rotate(-22 69 48)', fill: '#fff', opacity: '.5' });
      set(this.g.vig, { ...SPHERE, fill: `url(#${id}-vig)` });
      set(this.g.rim, { cx: 100, cy: 160, rx: 62, ry: 30, fill: `url(#${id}-rim)` });
      set(this.g.amb, { cx: 100, cy: 112, rx: 98, ry: 92, fill: `url(#${id}-amb)` });
    }

    _wake() {
      if (this.raf === null) {
        this.last = 0;
        this.raf = requestAnimationFrame(this._loop);
      }
    }

    destroy() {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      this.raf = null;
      if (this.motionQuery && this._onMotion) {
        this.motionQuery.removeEventListener('change', this._onMotion);
      }
    }

    _atRest() {
      if (this.blink > 0 || this.talkPhase >= 0 || this.particles.length) return false;
      for (const k in this.p) {
        if (Math.abs(this.target[k] - this.p[k]) > 0.0015) return false;
        if (Math.abs(this.v[k]) > 0.0015) return false;
      }
      return true;
    }

    /** Move toward an emotion. Springs handle the transition. */
    set(name, opts = {}) {
      const preset = EMOTIONS[name];
      if (!preset) return;
      this.emotion = name;
      Object.assign(this.target, preset, opts.override || {});

      // Rotate hue the short way round, or red -> rose sweeps the spectrum.
      let h = this.target.hue;
      while (h - this.p.hue > 180) h -= 360;
      while (h - this.p.hue < -180) h += 360;
      this.target.hue = h;

      if (opts.immediate || this.reduced) {
        Object.assign(this.p, this.target);
        for (const k in this.v) this.v[k] = 0;
      }
      this._wake();
    }

    startTalking() { this.talkPhase = 0; this._wake(); }
    stopTalking() { this.talkPhase = -1; }

    /** A one-shot physical reaction — the character reacts, then settles. */
    pulse(kind = 'bounce') {
      if (!this.reduced) {
        if (kind === 'bounce') { this.v.bob -= 190; this.v.squash -= 3.2; }
        if (kind === 'nod')    { this.v.tilt += 130; }
        if (kind === 'shake')  { this.v.tilt -= 190; }
        if (kind === 'blink')  { this.blink = 1; }
      }
      this._wake();
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
      if (this.reduced) {
        Object.assign(this.p, this.target);
        for (const k in this.v) this.v[k] = 0;
      } else {
        for (const k in this.p) this._spring(k, dt);
      }
      this._idle(dt);
      this._draw();
      if (this.reduced && this._atRest()) {
        this.raf = null;   // a still face costs nothing
        return;
      }
      this.raf = requestAnimationFrame(this._loop);
    }

    /** Involuntary life: breathing, blinking, a wandering gaze, particles. */
    _idle(dt) {
      if (this.reduced) return;
      const awake = this.target.lit > 0.4;

      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && awake && this.target.lidTop < 0.5) {
        this.blink = 1;
        this.nextBlink = 2.2 + Math.random() * 4;
      }
      if (this.blink > 0) this.blink = Math.max(0, this.blink - dt * 7.5);

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

      const sq = 1 + p.squash;
      g.body.setAttribute(
        'transform',
        `translate(100 ${100 + p.bob + breathe}) rotate(${p.tilt + drift}) scale(${1 / sq} ${sq}) translate(-100 -100)`
      );

      // ---- the sphere: one surface, lit from the upper left ----
      const h = ((p.hue % 360) + 360) % 360;
      const s = clamp(p.sat, 0, 1);
      const l = clamp(p.lum, 0.05, 0.95);
      const lit = clamp(p.lit, 0, 1.2);
      g.s0.setAttribute('stop-color', hsl(h, s * 0.82, l + 0.19));
      g.s1.setAttribute('stop-color', hsl(h, s, l));
      g.s2.setAttribute('stop-color', hsl(h, Math.min(1, s * 1.05), l - 0.27));

      // Bounce light along the lower edge keeps it reading as a sphere.
      g.r0.setAttribute('stop-color', hsl(h, s * 0.7, Math.min(0.92, l + 0.3)));
      g.r0.setAttribute('stop-opacity', (0.34 + lit * 0.12).toFixed(3));
      g.r1.setAttribute('stop-color', hsl(h, s * 0.7, l + 0.3));
      g.r1.setAttribute('stop-opacity', '0');

      // Ambient spill behind the sphere, tinted the same.
      g.a0.setAttribute('stop-color', hsl(h, s, Math.min(0.7, l + 0.06)));
      g.a0.setAttribute('stop-opacity', (clamp(p.glow, 0, 1) * 0.5 * clamp(lit, 0, 1)).toFixed(3));
      g.a1.setAttribute('stop-color', hsl(h, s, l));
      g.a1.setAttribute('stop-opacity', '0');

      // ---- the light inside ----
      // Lit, the core runs near-white and the bloom carries the hue. Unlit, it
      // settles to a shade slightly darker than the surface — an LED switched
      // off, still faintly there.
      const coreColor = hsl(h, lerp(s * 0.55, s * 0.22, clamp(lit, 0, 1)), lerp(l - 0.15, 0.97, clamp(lit, 0, 1)));
      const bloomColor = hsl(h, Math.min(1, s * 1.15), lerp(l, 0.82, clamp(lit, 0, 1)));
      g.core.style.color = coreColor;
      g.core.setAttribute('opacity', (0.86 + clamp(lit, 0, 1) * 0.1).toFixed(3));
      g.bloom.style.color = bloomColor;
      g.bloom.setAttribute('opacity', (clamp(lit, 0, 1.2) * 0.9).toFixed(3));
      g.haze.style.color = bloomColor;
      g.haze.setAttribute('opacity', (clamp(lit, 0, 1.2) * 0.55).toFixed(3));
      g.v1.setAttribute('stop-opacity', (0.3 + (1 - clamp(lit, 0, 1)) * 0.12).toFixed(3));

      // ---- eyes ----
      const lookX = (p.lookX + this.glance.x) * 7;
      const lookY = (p.lookY + this.glance.y) * 5;
      const r = EYE.r * clamp(p.eyeR, 0.2, 2);
      const lidTop = clamp(p.lidTop + this.blink, 0, 1.25);
      const shut = clamp((lidTop - 0.72) / 0.28, 0, 1);
      this._eye(g.eyeL, g.maskL, g.lidLineL, 100 - EYE.dx + lookX, EYE.y + lookY, r, lidTop, p.lidBot, p.lidCurve, shut, p.lidTilt, -1);
      this._eye(g.eyeR, g.maskR, g.lidLineR, 100 + EYE.dx + lookX, EYE.y + lookY, r, lidTop, p.lidBot, p.lidCurve, shut, p.lidTilt, 1);

      // ---- mouth ----
      let open = clamp(p.mouthOpen, 0, 1);
      if (this.talkPhase >= 0) {
        // Two detuned sines: speech-like, never a metronome.
        const wave = Math.sin(this.talkPhase * 15) * 0.5 + Math.sin(this.talkPhase * 23.7) * 0.3;
        open = clamp(0.42 + wave * 0.34, 0.08, 1);
      }
      g.mouth.setAttribute('d', this._mouthPath(100 + lookX * 0.5, MOUTH_Y + lookY * 0.4, p.mouthW, open, p.mouthCurve));

      this._drawParticles(h, s);
    }

    _eye(rect, mask, lidLine, cx, cy, r, lidTop, lidBot, lidCurve, shut, lidTilt, side) {
      const pad = r + 6;
      rect.setAttribute('x', cx - pad);
      rect.setAttribute('y', cy - pad);
      rect.setAttribute('width', pad * 2);
      rect.setAttribute('height', pad * 2);

      const [ellipse, top, bottom] = mask;
      ellipse.setAttribute('cx', cx);
      ellipse.setAttribute('cy', cy);
      ellipse.setAttribute('rx', r);
      ellipse.setAttribute('ry', r);

      // A level lid reads as a scowl. Angling it — mirrored across the face —
      // is the cue that separates sad and sleepy from angry.
      const ty = cy - r - 2 + lidTop * (2 * r + 4);
      const a = lidTilt * r * 0.55;
      const yL = ty - a * side;
      const yR = ty + a * side;
      top.setAttribute(
        'd',
        `M${cx - pad} ${cy - pad} H${cx + pad} V${yR} Q${cx} ${(yL + yR) / 2 + 5} ${cx - pad} ${yL} Z`
      );

      // Lower lid rises with a convex edge — that curve is what makes a smile
      // reach the eyes as a ^^ crescent.
      const by = cy + r + 2 - lidBot * (2 * r + 4);
      const bulge = by - lidCurve * r * 0.95;
      bottom.setAttribute('d', `M${cx - pad} ${cy + pad} H${cx + pad} V${by} Q${cx} ${bulge} ${cx - pad} ${by} Z`);

      // A shut eye is a drawn line, not an absence.
      lidLine.setAttribute('opacity', shut.toFixed(3));
      lidLine.setAttribute('stroke-width', Math.max(3, r * 0.3).toFixed(1));
      lidLine.setAttribute('d', `M${cx - r * 0.92} ${cy - 1} Q${cx} ${cy + r * 0.62} ${cx + r * 0.92} ${cy - 1}`);
    }

    /**
     * One path, three feelings: width, openness, curve.
     * Control offsets are doubled — a quadratic only reaches half of them.
     */
    _mouthPath(cx, cy, wScale, open, curve) {
      const w = 32 * clamp(wScale, 0.2, 1.6);
      const c = clamp(curve, -1, 1);
      const depth = 8 + open * 30;
      if (c >= 0) {
        // The signature grin: flat top edge, deep bowl beneath it.
        const topBow = -open * 4;
        const botBow = depth * (0.95 + c * 1.35);
        return `M${cx - w} ${cy} Q${cx} ${cy + topBow} ${cx + w} ${cy}` +
               ` Q${cx} ${cy + botBow} ${cx - w} ${cy} Z`;
      }
      // A frown is that shape mirrored, not thinned: the corners drop and the
      // centre lifts above them.
      const k = -c;
      const drop = k * depth * 0.55;
      const topBow = -depth * (0.95 + k * 1.35);
      const botBow = -open * 4;
      return `M${cx - w} ${cy + drop} Q${cx} ${cy + drop + topBow} ${cx + w} ${cy + drop}` +
             ` Q${cx} ${cy + drop + botBow} ${cx - w} ${cy + drop} Z`;
    }

    _drawParticles(h, s) {
      const fx = this.g.fx;
      while (fx.firstChild) fx.removeChild(fx.firstChild);
      for (const p of this.particles) {
        const k = p.life / p.max;
        const y = 56 - k * 44;
        const o = Math.sin(k * Math.PI);
        if (p.kind === 'z') {
          const t = el('text', {
            x: 142 + p.x + k * 12, y, fill: hsl(h, s * 0.5, 0.72), opacity: (o * 0.85).toFixed(2),
            'font-size': 16 + k * 10, 'font-family': 'var(--font, sans-serif)', 'font-weight': 700,
          });
          t.textContent = 'z';
          fx.appendChild(t);
        } else {
          fx.appendChild(el('circle', {
            cx: 100 + p.x + (p.kind === 'spark' ? Math.sin(k * 6) * 10 : 0),
            cy: y, r: (p.kind === 'heart' ? 7 : 5) * (1 - k * 0.4),
            fill: p.kind === 'heart' ? '#F2748C' : hsl(h, 0.9, 0.72),
            opacity: (o * 0.95).toFixed(2),
          }));
        }
      }
    }
  }

  global.FrenFace = { Face, EMOTIONS, ORDER };
})(window);
