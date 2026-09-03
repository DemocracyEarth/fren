'use strict';
/**
 * fren's face — a glossy orange sphere, built to the expression guide.
 *
 * Three rules from that guide drive the whole design:
 *
 *   1. The eyes are always plain white circles. No pupils, no gaze, no
 *      resizing to emote. Expression comes from mouth shape, eye closure,
 *      and deformation of the orb itself.
 *   2. The mouth always reads as a rounded form. It is one path, filled AND
 *      stroked with round caps and joins, so the outline stays round whether
 *      it is a hairline smile or a wide open grin — the two are the same
 *      shape with the edges pulled apart.
 *   3. The material is a fixed five-layer stack in a single hue. Tone moves
 *      along that ramp; it never breaks it.
 *
 * Every emotion is a point in one parameter space with a spring per
 * parameter, so any expression melts into any other, and the body carries a
 * little elastic overshoot — it should feel like something soft, not a decal.
 */
(function (global) {
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const hsl = (h, s, l, a) =>
    `hsl(${h.toFixed(1)} ${(clamp(s, 0, 1) * 100).toFixed(1)}% ${(clamp(l, 0, 1) * 100).toFixed(1)}%${
      a === undefined ? '' : ` / ${clamp(a, 0, 1).toFixed(3)}`
    })`;

  // ---- material -----------------------------------------------------------
  // Measured from the guide: #FFD08A #FFB14A #FF8A00 #E17200 #CC5A00.
  // Saturation is flat at 100% and the hue rotates toward red as it darkens,
  // so the ramp is expressed as offsets from BASE and stays coherent when the
  // whole thing is re-toned.
  const BASE = { h: 32.5, s: 1, l: 0.5 };
  const RAMP = {
    highlight: { dh: +3.4, dl: +0.271 },
    light: { dh: +1.6, dl: +0.145 },
    midDark: { dh: -2.1, dl: -0.059 },
    dark: { dh: -6.0, dl: -0.1 },
  };
  const step = (h, s, l, k) => hsl(h + k.dh, s, l + k.dl);

  // ---- parameters ---------------------------------------------------------
  // hue/sat/tone   the sphere's colour; tone slides along the ramp
  // lit            feature brightness — 0 is the light-off, private state
  // lidTop/Bot     eye closure from above / below (lidBot gives the ^^ arc)
  // lidTilt        lid angle, mirrored: + droops outer corners, - inner
  // eyeAsym        shrinks the right eye (the "curious" tell)
  // heart / cross  kawaii eye shapes, cross-faded against the circles
  // mouthW/Open/Curve/Wave   width, how far the lips part, smile↔frown, S-bend
  // tongue / blush kawaii extras
  // squash / lean / bob / tilt   deformation of the orb itself
  const NEUTRAL = {
    hue: 0, sat: 1, tone: 0, lit: 1,
    lidTop: 0, lidBot: 0, lidCurve: 0, lidTilt: 0, eyeAsym: 0,
    heart: 0, cross: 0,
    mouthW: 1, mouthOpen: 0.5, mouthCurve: 0.8, mouthWave: 0,
    tongue: 0, blush: 0,
    squash: 0, lean: 0, bob: 0, tilt: 0, glow: 0.5,
  };
  // Accents are comic shorthand, not parameters — they don't blend.
  const ACCENT = {
    excited: 'sparkle', joyful: 'sparkle', love: 'sparkle', overjoyed: 'sparkle',
    realization: 'impact', surprised: 'impact',
    worried: 'sweat', confused: 'sweat', shy: 'sweat',
    annoyed: 'vein', determined: 'vein',
  };
  const E = (o) => Object.assign({}, NEUTRAL, o);

  // Expressions from the guide. Nothing here resizes an eye to emote — only
  // the mouth, the lids, and the orb's own shape.
  const EMOTIONS = {
    // — the guide's set —
    happy:        E({ mouthOpen: 0.72, mouthW: 1.06, mouthCurve: 1, glow: 0.66 }),
    excited:      E({ mouthOpen: 0.95, mouthW: 1.16, mouthCurve: 1, tone: 0.06, bob: -2, glow: 0.8 }),
    joyful:       E({ mouthOpen: 0.86, mouthW: 1.12, mouthCurve: 1, tone: 0.04, glow: 0.74 }),
    calm:         E({ mouthOpen: 0.06, mouthW: 0.6, mouthCurve: 0.85, glow: 0.5 }),
    content:      E({ mouthOpen: 0.04, mouthW: 0.5, mouthCurve: 0.7, glow: 0.5 }),
    proud:        E({ mouthOpen: 0.05, mouthW: 0.54, mouthCurve: 0.8, tilt: -4, glow: 0.58 }),

    thinking:     E({ mouthOpen: 0.05, mouthW: 0.42, mouthCurve: 0.1, mouthWave: 0.5, tilt: 4, glow: 0.5 }),
    curious:      E({ eyeAsym: 0.45, mouthOpen: 0.34, mouthW: 0.24, mouthCurve: 0, tilt: -8, glow: 0.6 }),
    surprised:    E({ mouthOpen: 0.46, mouthW: 0.22, mouthCurve: 0, bob: -1.5, glow: 0.7 }),
    realization:  E({ mouthOpen: 0.5, mouthW: 0.26, mouthCurve: 0, tone: 0.08, bob: -3, glow: 0.9 }),
    focused:      E({ mouthOpen: 0.03, mouthW: 0.46, mouthCurve: 0, glow: 0.52 }),
    determined:   E({ mouthOpen: 0.03, mouthW: 0.52, mouthCurve: 0, lidTop: 0.12, lidTilt: -0.25, glow: 0.54 }),

    confused:     E({ mouthOpen: 0.05, mouthW: 0.5, mouthCurve: 0, mouthWave: 1, tilt: 9, glow: 0.48 }),
    concerned:    E({ mouthOpen: 0.05, mouthW: 0.54, mouthCurve: -0.6, lidTilt: 0.35, glow: 0.44 }),
    worried:      E({ mouthOpen: 0.06, mouthW: 0.58, mouthCurve: -0.8, lidTilt: 0.45, glow: 0.4 }),
    sad:          E({ mouthOpen: 0.05, mouthW: 0.56, mouthCurve: -0.95, lidTilt: 0.6, lidTop: 0.12,
                      bob: 2, squash: 0.035, glow: 0.3 }),
    disappointed: E({ mouthOpen: 0.04, mouthW: 0.5, mouthCurve: -0.7, lidTilt: 0.5, lidTop: 0.2, glow: 0.34 }),
    tired:        E({ lidTop: 0.55, lidTilt: 0.3, mouthOpen: 0.03, mouthW: 0.44, mouthCurve: -0.1, glow: 0.32 }),

    resting:      E({ lidTop: 0.94, lidCurve: 0.55, lidTilt: 0.25, mouthOpen: 0.05, mouthW: 0.44,
                      mouthCurve: 0.8, glow: 0.42 }),
    peaceful:     E({ lidTop: 0.96, lidCurve: 0.6, lidTilt: 0.25, mouthOpen: 0.2, mouthW: 0.14,
                      mouthCurve: 0, glow: 0.4 }),
    sleepy:       E({ lidTop: 0.97, lidCurve: 0.6, lidTilt: 0.3, mouthOpen: 0.22, mouthW: 0.14,
                      mouthCurve: 0, bob: 1.2, glow: 0.28 }),

    blushing:     E({ blush: 1, mouthOpen: 0.1, mouthW: 0.5, mouthCurve: 0.8, tone: 0.03, glow: 0.6 }),
    shy:          E({ blush: 1, lidTop: 0.2, lidTilt: 0.2, mouthOpen: 0.06, mouthW: 0.4,
                      mouthCurve: 0.7, tilt: -7, glow: 0.54 }),
    love:         E({ heart: 1, mouthOpen: 0.66, mouthW: 1.02, mouthCurve: 1, blush: 0.5,
                      tone: 0.04, glow: 0.82 }),

    hopeful:      E({ mouthOpen: 0.08, mouthW: 0.56, mouthCurve: 0.85, bob: -1, glow: 0.62 }),
    playful:      E({ tongue: 1, mouthOpen: 0.3, mouthW: 0.72, mouthCurve: 0.9, tilt: -5, glow: 0.66 }),
    cheeky:       E({ tongue: 1, mouthOpen: 0.36, mouthW: 0.66, mouthCurve: 0.85, tilt: 6,
                      eyeAsym: 0.2, glow: 0.68 }),
    silly:        E({ mouthOpen: 0.12, mouthW: 0.6, mouthCurve: 0, mouthWave: 1.2, glow: 0.6 }),
    laughing:     E({ lidBot: 0.62, lidCurve: 1, mouthOpen: 0.92, mouthW: 1.1, mouthCurve: 1,
                      tone: 0.05, bob: -2, glow: 0.82 }),
    overjoyed:    E({ cross: 1, mouthOpen: 0.95, mouthW: 1.14, mouthCurve: 1, tone: 0.07,
                      bob: -3, glow: 0.9 }),

    // — states the app itself needs —
    // Not watching: the light goes out and the material drops to the bottom of
    // its own ramp. Eyes shut. This is the privacy signal.
    private:      E({ lit: 0.04, tone: -0.3, sat: 0.5, lidTop: 0.94, lidCurve: 0.55, lidTilt: 0.3,
                      mouthOpen: 0.05, mouthW: 0.44, mouthCurve: 0.8, glow: 0 }),
    sleeping:     E({ lit: 0.03, tone: -0.34, sat: 0.45, lidTop: 0.97, lidCurve: 0.6, lidTilt: 0.32,
                      mouthOpen: 0.2, mouthW: 0.14, mouthCurve: 0, glow: 0, bob: 1.2 }),
    waking:       E({ lit: 0.6, tone: -0.12, lidTop: 0.42, lidTilt: 0.2, mouthOpen: 0.1,
                      mouthW: 0.5, mouthCurve: 0.6, glow: 0.3 }),
    watching:     E({ mouthOpen: 0.2, mouthW: 0.66, mouthCurve: 0.9, glow: 0.62 }),
    listening:    E({ mouthOpen: 0.14, mouthW: 0.6, mouthCurve: 0.9, tilt: -5, glow: 0.62 }),
    processing:   E({ lidTop: 0.3, mouthOpen: 0.04, mouthW: 0.4, mouthCurve: 0, glow: 0.46 }),
    talking:      E({ mouthOpen: 0.6, mouthW: 0.88, mouthCurve: 0.9, glow: 0.64 }),
  };

  // Aliases so app code can keep speaking in its own terms.
  EMOTIONS.neutral = EMOTIONS.calm;
  EMOTIONS.idea = EMOTIONS.realization;
  EMOTIONS.delighted = EMOTIONS.joyful;
  EMOTIONS.mischief = EMOTIONS.cheeky;
  EMOTIONS.wink = EMOTIONS.playful;
  EMOTIONS.annoyed = E({ lidTop: 0.28, lidTilt: -0.55, mouthOpen: 0.06, mouthW: 0.5,
                         mouthCurve: -0.35, glow: 0.46 });
  EMOTIONS.bored = EMOTIONS.tired;
  EMOTIONS.oops = EMOTIONS.surprised;
  EMOTIONS.alert = EMOTIONS.focused;
  EMOTIONS.relieved = EMOTIONS.resting;

  const ORDER = [
    'happy', 'excited', 'joyful', 'calm', 'content', 'proud',
    'thinking', 'curious', 'surprised', 'realization', 'focused', 'determined',
    'confused', 'concerned', 'worried', 'sad', 'disappointed', 'tired',
    'resting', 'peaceful', 'sleepy', 'blushing', 'shy', 'love',
    'hopeful', 'playful', 'cheeky', 'silly', 'laughing', 'overjoyed',
    'private', 'sleeping', 'waking', 'watching', 'listening', 'talking',
  ];

  // Lids and mouth snap; the body is loose and springy so it overshoots a
  // little — that elasticity is what makes it read as soft plastic.
  const SPRING = {
    _default: [170, 16],
    lidTop: [320, 24], lidBot: [270, 22], lidTilt: [230, 20],
    mouthOpen: [260, 21], mouthW: [230, 20], mouthCurve: [220, 19], mouthWave: [200, 18],
    squash: [150, 9], lean: [130, 9], bob: [125, 11], tilt: [120, 12],
    hue: [70, 17], sat: [80, 18], tone: [85, 18], lit: [95, 18],
    heart: [260, 22], cross: [260, 22], tongue: [240, 21], blush: [140, 17],
  };

  const R = 74;                       // sphere radius in a 200 viewBox
  // Measured off the logo: eyes at 0.50R apart and 0.143R across, mouth
  // 0.67R wide with a depth of 0.61 x its half-width — a shallow half-disc.
  const EYE = { dx: 36, y: 88, r: 11 };
  const MOUTH_Y = 118;
  const MOUTH_W = 48;
  const MOUTH_STROKE = 8;             // gives every mouth its rounded outline

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const FINISH = {
    glossy: { spec: 0.95, specR: 1.08, glow: 1 },
    satin: { spec: 0.5, specR: 1.25, glow: 0.9 },
    matte: { spec: 0.22, specR: 1.5, glow: 0.7 },
    softGlow: { spec: 0.6, specR: 1.15, glow: 1.6 },
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
      this.finish = FINISH[opts.finish] || FINISH.glossy;
      // Start dark and shut: if anything upstream fails, fren must look like
      // it is NOT watching.
      this.p = Object.assign({}, EMOTIONS.private);
      this.target = Object.assign({}, EMOTIONS.private);
      this.v = {};
      for (const k in this.p) this.v[k] = 0;

      this.emotion = 'private';
      this.t = 0;
      this.nextBlink = 1.5;
      this.blink = 0;
      this.blinkQueue = 0;        // occasional double blink
      this.nextTwitch = 3 + Math.random() * 6;
      this.gaze = { x: 0, y: 0 };     // whole-orb lean toward the pointer
      this.gazeTarget = { x: 0, y: 0 };
      this.talkPhase = -1;
      this.speechLevel = null;    // when set, real audio drives the mouth
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
      svg.innerHTML = `
        <defs>
          <!-- 2/3/4: top light -> base -> shade, one hue -->
          <radialGradient id="${id}-body" cx="35%" cy="24%" r="82%">
            <stop class="s0" offset="0%"/>
            <stop class="sa" offset="26%"/>
            <stop class="s1" offset="58%"/>
            <stop class="s2" offset="88%"/>
            <stop class="sb" offset="100%"/>
          </radialGradient>
          <!-- 1: strong, soft-edged specular -->
          <radialGradient id="${id}-spec">
            <stop class="p0" offset="0%" stop-color="#fff"/>
            <stop offset="55%" stop-color="#fff" stop-opacity=".16"/>
            <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
          </radialGradient>
          <!-- soft rim light along the lower edge -->
          <radialGradient id="${id}-rim">
            <stop class="r0" offset="0%"/>
            <stop class="r1" offset="100%"/>
          </radialGradient>
          <!-- 5: contact shadow / ambient occlusion -->
          <radialGradient id="${id}-ao">
            <stop class="o0" offset="0%" stop-color="#000"/>
            <stop offset="100%" stop-color="#000" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="${id}-amb">
            <stop class="a0" offset="0%"/>
            <stop class="a1" offset="100%"/>
          </radialGradient>
          <clipPath id="${id}-clip"><circle cx="100" cy="100" r="${R}"/></clipPath>
          <filter id="${id}-bloom" x="-20%" y="-30%" width="140%" height="160%">
            <feGaussianBlur stdDeviation="4.5"/>
          </filter>
          <filter id="${id}-soft" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="7"/>
          </filter>
          <filter id="${id}-halo" x="-38%" y="-58%" width="176%" height="216%">
            <feGaussianBlur stdDeviation="10"/>
          </filter>
          <filter id="${id}-spill" x="-82%" y="-128%" width="264%" height="356%">
            <feGaussianBlur stdDeviation="24"/>
          </filter>
          <radialGradient id="${id}-mouthglow" cx="50%" cy="42%" r="66%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
            <stop offset="52%" stop-color="#FFE7B5" stop-opacity="0"/>
            <stop offset="82%" stop-color="#FFC46A" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#FF9A2E" stop-opacity="0.92"/>
          </radialGradient>
          <radialGradient id="${id}-eyeglow" cx="42%" cy="36%" r="72%">
            <stop offset="0%" stop-color="#fff"/>
            <stop offset="72%" stop-color="#fff"/>
            <stop offset="100%" stop-color="#FFE0A8"/>
          </radialGradient>
          <mask id="${id}-eyeL"><ellipse fill="#fff"/><path fill="#000"/><path fill="#000"/></mask>
          <mask id="${id}-eyeR"><ellipse fill="#fff"/><path fill="#000"/><path fill="#000"/></mask>
          <g id="${id}-feat" fill="currentColor">
            <rect class="eyeL" mask="url(#${id}-eyeL)"/>
            <rect class="eyeR" mask="url(#${id}-eyeR)"/>
            <circle class="glowL" mask="url(#${id}-eyeL)" fill="url(#${id}-eyeglow)"/>
            <circle class="glowR" mask="url(#${id}-eyeR)" fill="url(#${id}-eyeglow)"/>
            <path class="heartL"/><path class="heartR"/>
            <g class="crossL" stroke="currentColor" stroke-linecap="round" fill="none">
              <path/><path/>
            </g>
            <g class="crossR" stroke="currentColor" stroke-linecap="round" fill="none">
              <path/><path/>
            </g>
            <path class="lidLineL" fill="none" stroke="currentColor" stroke-linecap="round"/>
            <path class="lidLineR" fill="none" stroke="currentColor" stroke-linecap="round"/>
            <path class="mouth" stroke="currentColor" stroke-width="${MOUTH_STROKE}"
                  stroke-linejoin="round" stroke-linecap="round"/>
          </g>
        </defs>
        <ellipse class="amb"/>
        <ellipse class="ao"/>
        <g class="body" style="isolation:isolate">
          <circle class="sphere"/>
          <g clip-path="url(#${id}-clip)">
            <ellipse class="rim"/>
            <ellipse class="blushL"/><ellipse class="blushR"/>
            <use class="spill" href="#${id}-feat" filter="url(#${id}-spill)" style="mix-blend-mode:screen"/>
            <use class="halo" href="#${id}-feat" filter="url(#${id}-halo)" style="mix-blend-mode:screen"/>
            <use class="bloom" href="#${id}-feat" filter="url(#${id}-bloom)" style="mix-blend-mode:screen"/>
            <use class="core" href="#${id}-feat"/>
            <path class="mouthHot" fill="url(#${id}-mouthglow)" style="mix-blend-mode:multiply"/>
            <path class="tongue"/>
            <ellipse class="spec"/>
          </g>
        </g>
        <g class="fx"></g>`;
      mount.appendChild(svg);
      this.mount = mount;

      const q = (s) => svg.querySelector(s);
      this.svg = svg;
      this.g = {
        amb: q('.amb'), ao: q('.ao'), body: q('.body'), sphere: q('.sphere'), rim: q('.rim'),
        spec: q('.spec'), bloom: q('.bloom'), core: q('.core'), fx: q('.fx'),
        spill: q('.spill'), halo: q('.halo'), mouthHot: q('.mouthHot'),
        blushL: q('.blushL'), blushR: q('.blushR'), tongue: q('.tongue'),
        eyeL: q(`#${id}-feat .eyeL`), eyeR: q(`#${id}-feat .eyeR`),
        glowL: q('.glowL'), glowR: q('.glowR'),
        heartL: q('.heartL'), heartR: q('.heartR'),
        crossL: q('.crossL'), crossR: q('.crossR'),
        crossLp: svg.querySelectorAll('.crossL path'),
        crossRp: svg.querySelectorAll('.crossR path'),
        lidLineL: q('.lidLineL'), lidLineR: q('.lidLineR'), mouth: q('.mouth'),
        maskL: svg.querySelectorAll(`#${id}-eyeL > *`),
        maskR: svg.querySelectorAll(`#${id}-eyeR > *`),
        s0: q(`#${id}-body .s0`), sa: q(`#${id}-body .sa`), s1: q(`#${id}-body .s1`),
        s2: q(`#${id}-body .s2`), sb: q(`#${id}-body .sb`),
        p0: q(`#${id}-spec .p0`),
        r0: q(`#${id}-rim .r0`), r1: q(`#${id}-rim .r1`),
        o0: q(`#${id}-ao .o0`),
        a0: q(`#${id}-amb .a0`), a1: q(`#${id}-amb .a1`),
      };

      const set = (n, a) => { for (const k in a) n.setAttribute(k, a[k]); };
      const f = this.finish;
      set(this.g.sphere, { cx: 100, cy: 100, r: R, fill: `url(#${id}-body)` });
      set(this.g.spec, {
        cx: 74, cy: 52, rx: 26 * f.specR, ry: 19 * f.specR,
        transform: 'rotate(-24 74 52)', fill: `url(#${id}-spec)`,
      });
      set(this.g.rim, { cx: 100, cy: 156, rx: 60, ry: 30, fill: `url(#${id}-rim)` });
      set(this.g.ao, { cx: 103, cy: 180, rx: 66, ry: 19, fill: `url(#${id}-ao)`, filter: `url(#${id}-soft)` });
      set(this.g.amb, { cx: 100, cy: 108, rx: 96, ry: 92, fill: `url(#${id}-amb)` });
      this.g.p0.setAttribute('stop-opacity', f.spec.toFixed(2));
    }

    _wake() {
      if (this.raf === null) { this.last = 0; this.raf = requestAnimationFrame(this._loop); }
    }

    destroy() {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
      this.raf = null;
      if (this.motionQuery && this._onMotion) {
        this.motionQuery.removeEventListener('change', this._onMotion);
      }
    }

    _atRest() {
      if (this.thinking) return false;
      if (this.blink > 0 || this.talkPhase >= 0 || this.speechLevel !== null || this.particles.length) return false;
      for (const k in this.p) {
        if (Math.abs(this.target[k] - this.p[k]) > 0.0015) return false;
        if (Math.abs(this.v[k]) > 0.0015) return false;
      }
      return true;
    }

    /** Move toward an expression. Springs do the transition. */
    set(name, opts = {}) {
      const preset = EMOTIONS[name];
      if (!preset) return;
      const changed = this.emotion !== name;
      this.emotion = name;
      Object.assign(this.target, preset, opts.override || {});

      let h = this.target.hue;
      while (h - this.p.hue > 180) h -= 360;
      while (h - this.p.hue < -180) h += 360;
      this.target.hue = h;

      if (opts.immediate || this.reduced) {
        Object.assign(this.p, this.target);
        for (const k in this.v) this.v[k] = 0;
      } else if (changed) {
        // A soft body reacts to its own change of mind.
        this.v.squash -= 1.1;
      }
      this._wake();
    }

    /** Lean the whole orb toward a point (-1..1). The eyes never move. */
    lookAt(nx, ny) {
      this.gazeTarget = { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
      this._wake();
    }
    lookAway() { this.gazeTarget = { x: 0, y: 0 }; this._wake(); }

    startTalking() { this.talkPhase = 0; this._wake(); }
    stopTalking() { this.talkPhase = -1; this.speechLevel = null; }

    /** Looking for the word: the gaze drifts up and about until the answer comes. */
    think(on) {
      this.thinking = !!on;
      if (!this.thinking) this.gazeTarget = { x: 0, y: 0 };
      this._wake();
    }

    /**
     * Drive the mouth from the actual audio being played (0..1), so the lips
     * match the voice instead of miming to a sine wave. Pass null to fall
     * back to the synthetic pattern.
     */
    /**
     * The 3D renderer brightens with your voice while listening. This one has
     * no equivalent, but the method must exist: app.js calls it on every
     * recording, and a missing method here would throw on the fallback path
     * that exists precisely for machines where things go wrong.
     */
    setListening() { /* no visual equivalent in the SVG renderer */ }

    /**
     * The closest a drawn face gets to being shaken: kick the velocity springs
     * it already has, hard and in random directions. There is no jelly surface
     * here — the 3D renderer does that with a vertex shader — so this leans,
     * squashes and bobs instead, which is the honest equivalent.
     */
    shake(power = 1) {
      if (this.reduced) return;
      const p = Math.max(0, Math.min(1, power));
      const r = () => (Math.random() * 2 - 1);
      this.v.lean += r() * 7 * p;
      this.v.tilt += r() * 150 * p;
      this.v.squash += r() * 6 * p;
      this.v.bob -= (120 + Math.random() * 120) * p;
      this._wake();
    }

    /** The viewBox is fixed, so a new size is two attributes and nothing else. */
    resize(px) {
      const n = Math.max(1, Math.round(px));
      this.svg.setAttribute('width', n);
      this.svg.setAttribute('height', n);
      this._wake();
    }


    // A drawn face cannot roll like a ball — spinning a flat one reads as a
    // sticker turning, not as a sphere. The size still changes; only the
    // tumble is missing, and only on the fallback renderer.
    roll() { /* no visual equivalent in the SVG renderer */ }

    setSpeechLevel(v) {
      this.speechLevel = v === null || v === undefined ? null : clamp(v, 0, 1);
      this._wake();
    }

    /** One-shot elastic reactions — the orb is plastic, so it wobbles. */
    pulse(kind = 'bounce') {
      if (!this.reduced) {
        if (kind === 'bounce') { this.v.bob -= 210; this.v.squash -= 4.2; }   // rises stretched
        if (kind === 'squash') { this.v.squash += 5; }
        if (kind === 'stretch') { this.v.squash -= 5; }
        if (kind === 'nod') { this.v.tilt += 130; }
        if (kind === 'shake') { this.v.lean -= 4.5; }
        if (kind === 'blink') { this.blink = 1; }
      }
      this._wake();
    }

    _spring(k, dt) {
      const [stiff, damp] = SPRING[k] || SPRING._default;
      this.v[k] += ((this.target[k] - this.p[k]) * stiff - this.v[k] * damp) * dt;
      this.p[k] += this.v[k] * dt;
    }

    _loop(now) {
      const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
      this.last = now;
      this.t += dt;
      if (this.reduced) {
        Object.assign(this.p, this.target);
        for (const k in this.v) this.v[k] = 0;
        this.gaze = { ...this.gazeTarget };
      } else {
        for (const k in this.p) this._spring(k, dt);
        this.gaze.x += (this.gazeTarget.x - this.gaze.x) * Math.min(1, dt * 6);
        this.gaze.y += (this.gazeTarget.y - this.gaze.y) * Math.min(1, dt * 6);
      }
      this._idle(dt);
      this._draw();
      if (this.reduced && this._atRest()) { this.raf = null; return; }
      this.raf = requestAnimationFrame(this._loop);
    }

    _idle(dt) {
      // Transient state drains FIRST, and unconditionally. _atRest() is false
      // while any particle is alive, so skipping this under reduced motion
      // strands whatever was on screen and the loop can never halt.
      for (const p of this.particles) p.life += dt;
      this.particles = this.particles.filter((p) => p.life < p.max);
      if (this.blink > 0) {
        this.blink = Math.max(0, this.blink - dt * 8);
        if (this.blink === 0 && this.blinkQueue > 0) {
          this.blinkQueue -= 1;
          this.blink = 1;
        }
      }
      if (this.reduced) {
        this.blinkQueue = 0;   // let a blink in flight finish, then stay open
        return;
      }
      if (this.thinking) {
        // Eyes up and wandering, the way a person looks for a word.
        this.gazeTarget = { x: Math.sin(this.t * 0.9) * 0.45, y: -0.6 + Math.sin(this.t * 1.7) * 0.12 };
      }
      const awake = this.target.lit > 0.4;
      this.nextBlink -= dt;
      if (this.nextBlink <= 0 && awake && this.target.lidTop < 0.5) {
        this.blink = 1;
        // Roughly one blink in five comes in a pair — real eyes do this.
        this.blinkQueue = Math.random() < 0.22 ? 1 : 0;
        this.nextBlink = 2.4 + Math.random() * 4;
      }

      // Involuntary shifts of weight, so it is never perfectly still.
      this.nextTwitch -= dt;
      if (this.nextTwitch <= 0) {
        if (awake) {
          const r = Math.random();
          if (r < 0.4) this.v.lean += (Math.random() - 0.5) * 2.4;
          else if (r < 0.75) this.v.tilt += (Math.random() - 0.5) * 34;
          else this.v.bob -= 12 + Math.random() * 18;
        }
        this.nextTwitch = 3.5 + Math.random() * 7;
      }
      if (this.talkPhase >= 0) this.talkPhase += dt;

      const kind = this.emotion === 'sleeping' ? 'z'
        : this.emotion === 'realization' || this.emotion === 'idea' ? 'spark'
        : this.emotion === 'love' ? 'heart' : null;
      this.nextParticle -= dt;
      if (kind && this.nextParticle <= 0) {
        this.particles.push({ kind, life: 0, max: kind === 'z' ? 2.8 : 1.1, x: (Math.random() - 0.5) * 26 });
        this.nextParticle = kind === 'z' ? 1.5 : 0.28;
      }
    }

    _draw() {
      const p = this.p;
      const g = this.g;
      const breathe = this.reduced ? 0 : Math.sin(this.t * 1.5) * 1.1;

      // ---- deformation: squash & stretch plus a lean, both elastic ----
      // Animation convention: +squash flattens (wider, shorter),
      // -squash stretches (taller, narrower). +lean tips the top rightward.
      const sq = 1 + clamp(p.squash, -0.45, 0.45);
      const lean = p.lean - this.gaze.x * 2.2;   // tips toward the pointer
      const cy = 100 + p.bob + breathe + this.gaze.y * 2;
      g.body.setAttribute(
        'transform',
        `translate(${100 + this.gaze.x * 3} ${cy}) rotate(${p.tilt}) skewX(${lean}) ` +
        `scale(${sq} ${1 / sq}) translate(-100 -100)`
      );

      // ---- material: five layers, one hue ----
      const h = ((p.hue + BASE.h) % 360 + 360) % 360;
      const s = clamp(BASE.s * p.sat, 0, 1);
      const l = clamp(BASE.l + p.tone, 0.06, 0.92);
      const lit = clamp(p.lit, 0, 1);
      g.s0.setAttribute('stop-color', step(h, s, l, RAMP.highlight));
      g.sa.setAttribute('stop-color', step(h, s, l, RAMP.light));
      g.s1.setAttribute('stop-color', hsl(h, s, l));
      g.s2.setAttribute('stop-color', step(h, s, l, RAMP.midDark));
      g.sb.setAttribute('stop-color', step(h, s, l, RAMP.dark));

      g.r0.setAttribute('stop-color', step(h, s, l, RAMP.highlight));
      g.r0.setAttribute('stop-opacity', (0.3 + lit * 0.1).toFixed(3));
      g.r1.setAttribute('stop-color', step(h, s, l, RAMP.light));
      g.r1.setAttribute('stop-opacity', '0');

      g.o0.setAttribute('stop-opacity', (0.72 - lit * 0.08).toFixed(3));

      g.a0.setAttribute('stop-color', hsl(h, s, Math.min(0.66, l + 0.08)));
      g.a0.setAttribute('stop-opacity', (clamp(p.glow, 0, 1) * 0.42 * lit * this.finish.glow).toFixed(3));
      g.a1.setAttribute('stop-color', hsl(h, s, l));
      g.a1.setAttribute('stop-opacity', '0');

      // Features are white — the guide is explicit. Unlit, they sink toward
      // the shaded material instead of vanishing.
      const core = lit > 0.5
        ? hsl(0, 0, lerp(0.84, 1, (lit - 0.5) * 2))
        : step(h, s, l, RAMP.dark);
      g.core.style.color = core;
      g.core.setAttribute('opacity', (0.9 + lit * 0.1).toFixed(3));

      // A filament is never perfectly steady. Tie a small flicker to the same
      // clock as the breath so the light reads as powered, not painted.
      const flicker = this.reduced
        ? 1
        : 1 + Math.sin(this.t * 2.3) * 0.05 + Math.sin(this.t * 6.1) * 0.018;
      const glow = lit * this.finish.glow * flicker;

      // Near the source: warm white, only just off the core.
      g.bloom.style.color = hsl(h + 12, Math.min(1, s * 0.55), Math.min(0.95, l + 0.42));
      g.bloom.setAttribute('opacity', (glow * 0.78).toFixed(3));
      // Mid falloff: full amber.
      g.halo.style.color = hsl(h + 5, Math.min(1, s * 0.95), Math.min(0.88, l + 0.3));
      g.halo.setAttribute('opacity', (glow * 0.5).toFixed(3));
      // Far spill: the material's own hue, so the sphere looks lit from within
      // rather than having something bright sitting on top of it.
      g.spill.style.color = hsl(h, Math.min(1, s), Math.min(0.72, l + 0.16));
      g.spill.setAttribute('opacity', (glow * 0.42).toFixed(3));

      // ---- eyes: plain white circles, expression is closure only ----
      const lidTop = clamp(p.lidTop + this.blink, 0, 1.25);
      const shut = clamp((lidTop - 0.72) / 0.28, 0, 1);
      const special = clamp(p.heart + p.cross, 0, 1);
      const rL = EYE.r;
      const rR = EYE.r * (1 - clamp(p.eyeAsym, 0, 0.7));
      this._eye(g.eyeL, g.maskL, g.lidLineL, 100 - EYE.dx, EYE.y, rL, lidTop, p.lidBot, p.lidCurve, shut, p.lidTilt, -1, 1 - special);
      this._eye(g.eyeR, g.maskR, g.lidLineR, 100 + EYE.dx, EYE.y, rR, lidTop, p.lidBot, p.lidCurve, shut, p.lidTilt, 1, 1 - special);
      for (const [node, x, r] of [[g.glowL, 100 - EYE.dx, rL], [g.glowR, 100 + EYE.dx, rR]]) {
        node.setAttribute('cx', x);
        node.setAttribute('cy', EYE.y);
        node.setAttribute('r', r);
        node.setAttribute('opacity', (lit * (1 - special)).toFixed(3));
      }
      this._heart(g.heartL, 100 - EYE.dx, EYE.y, p.heart);
      this._heart(g.heartR, 100 + EYE.dx, EYE.y, p.heart);
      this._cross(g.crossL, g.crossLp, 100 - EYE.dx, EYE.y, p.cross);
      this._cross(g.crossR, g.crossRp, 100 + EYE.dx, EYE.y, p.cross);

      // ---- mouth ----
      let open = clamp(p.mouthOpen, 0, 1);
      if (this.speechLevel !== null) {
        open = clamp(0.06 + this.speechLevel * 0.9, 0.06, 1);
      } else if (this.talkPhase >= 0) {
        const wave = Math.sin(this.talkPhase * 15) * 0.5 + Math.sin(this.talkPhase * 23.7) * 0.3;
        open = clamp(0.5 + wave * 0.36, 0.06, 1);
      }
      const mouthD = this._mouthPath(p.mouthW, open, p.mouthCurve, p.mouthWave);
      g.mouth.setAttribute('d', mouthD);
      g.mouthHot.setAttribute('d', mouthD);
      // Only worth showing once the mouth is open enough to have an inside.
      g.mouthHot.setAttribute('opacity', (lit * clamp(open * 1.6, 0, 1) * 0.9).toFixed(3));

      // ---- kawaii extras ----
      const bl = clamp(p.blush, 0, 1);
      for (const [node, x] of [[g.blushL, 100 - 44], [g.blushR, 100 + 44]]) {
        node.setAttribute('cx', x);
        node.setAttribute('cy', 104);
        node.setAttribute('rx', 15);
        node.setAttribute('ry', 9);
        node.setAttribute('fill', step(h, Math.min(1, s), l - 0.14, { dh: -12, dl: 0 }));
        node.setAttribute('opacity', (bl * 0.55).toFixed(3));
        node.setAttribute('filter', `url(#${this.id}-soft)`);
      }
      const tg = clamp(p.tongue, 0, 1);
      g.tongue.setAttribute('opacity', tg.toFixed(3));
      const tw = 12 * tg;
      const lip = MOUTH_Y + (0.8 * (16 + open * 12)) + open * 26 * 0.75;   // lower lip
      g.tongue.setAttribute(
        'd',
        `M${100 - tw} ${lip - 7} Q${100} ${lip + 13 * tg} ${100 + tw} ${lip - 7} Z`
      );
      g.tongue.setAttribute('fill', hsl(6, 0.72, 0.6));

      this._drawParticles(h, s, l);
      this._drawAccent(ACCENT[this.emotion], h, s, l);
    }

    _eye(rect, mask, lidLine, cx, cy, r, lidTop, lidBot, lidCurve, shut, lidTilt, side, vis) {
      rect.setAttribute('opacity', vis.toFixed(3));
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

      const ty = cy - r - 2 + lidTop * (2 * r + 4);
      const a = lidTilt * r * 0.55;
      const yL = ty - a * side;
      const yR = ty + a * side;
      top.setAttribute('d',
        `M${cx - pad} ${cy - pad} H${cx + pad} V${yR} Q${cx} ${(yL + yR) / 2 + 4} ${cx - pad} ${yL} Z`);

      const by = cy + r + 2 - lidBot * (2 * r + 4);
      bottom.setAttribute('d',
        `M${cx - pad} ${cy + pad} H${cx + pad} V${by} Q${cx} ${by - lidCurve * r * 0.95} ${cx - pad} ${by} Z`);

      lidLine.setAttribute('opacity', (shut * vis).toFixed(3));
      lidLine.setAttribute('stroke-width', Math.max(3.5, r * 0.34).toFixed(1));
      lidLine.setAttribute('d', `M${cx - r} ${cy - 1} Q${cx} ${cy + r * 0.7} ${cx + r} ${cy - 1}`);
    }

    _heart(node, cx, cy, k) {
      node.setAttribute('opacity', clamp(k, 0, 1).toFixed(3));
      const s = EYE.r * 1.55 * clamp(k, 0.001, 1);
      node.setAttribute(
        'd',
        `M${cx} ${cy + s * 0.75} C${cx - s * 1.5} ${cy - s * 0.35} ${cx - s * 0.55} ${cy - s * 1.2} ${cx} ${cy - s * 0.42}` +
        ` C${cx + s * 0.55} ${cy - s * 1.2} ${cx + s * 1.5} ${cy - s * 0.35} ${cx} ${cy + s * 0.75} Z`
      );
    }

    _cross(group, paths, cx, cy, k) {
      group.setAttribute('opacity', clamp(k, 0, 1).toFixed(3));
      const s = EYE.r * 0.95;
      group.setAttribute('stroke-width', (EYE.r * 0.52).toFixed(1));
      paths[0].setAttribute('d', `M${cx - s} ${cy - s} L${cx + s} ${cy + s}`);
      paths[1].setAttribute('d', `M${cx + s} ${cy - s} L${cx - s} ${cy + s}`);
    }

    /**
     * One mouth, always round. The path is filled AND stroked with round caps
     * and joins, so a closed mouth is a rounded line and an open one is the
     * same curve with its edges pulled apart — the outline never goes sharp.
     */
    _mouthPath(wScale, open, curve, wave) {
      const w = MOUTH_W * clamp(wScale, 0.1, 1.6);
      const c = clamp(curve, -1, 1);
      const cx = 100;
      const cy = MOUTH_Y;

      // Control points sit near the corners so the sides stay vertical and
      // the bottom stays round. Pull them inward and it becomes a triangle.
      const kx = w * 0.94;
      const lip = c * 10;                 // resting curve of a closed mouth
      const drop = open * (13 + w * 0.46); // round even when the mouth is narrow
      const top = lip - drop * 0.1;       // the upper lip barely moves
      const bot = lip + drop;
      const k = 1.3333;                   // cubic reaches 3/4 of its control
      const s = wave * 8;

      return `M${cx - w} ${cy}` +
             ` C${cx - kx} ${cy + top * k + s} ${cx + kx} ${cy + top * k - s} ${cx + w} ${cy}` +
             ` C${cx + kx} ${cy + bot * k - s} ${cx - kx} ${cy + bot * k + s} ${cx - w} ${cy} Z`;
    }

    /** Comic-book shorthand drawn beside the orb: sparkles, sweat, vein, impact. */
    _drawAccent(kind, h, s, l) {
      if (!kind) return;
      const fx = this.g.fx;
      const ink = step(h, s, l, RAMP.highlight);
      const t = this.t;
      const star = (x, y, r, o) => {
        const p = `M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r}` +
                  ` Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r} Z`;
        fx.appendChild(el('path', { d: p, fill: ink, opacity: o.toFixed(2) }));
      };
      if (kind === 'sparkle') {
        const beat = (i) => 0.45 + 0.55 * Math.abs(Math.sin(t * 2.2 + i * 1.7));
        star(168, 40, 9 * beat(0), beat(0));
        star(38, 56, 6 * beat(1), beat(1) * 0.85);
        star(150, 18, 5 * beat(2), beat(2) * 0.7);
      } else if (kind === 'impact') {
        for (let i = 0; i < 7; i++) {
          const a = (-140 + i * 22) * (Math.PI / 180);
          const r0 = 82 + Math.sin(t * 6) * 2;
          fx.appendChild(el('line', {
            x1: 100 + Math.cos(a) * r0, y1: 96 + Math.sin(a) * r0,
            x2: 100 + Math.cos(a) * (r0 + 15), y2: 96 + Math.sin(a) * (r0 + 15),
            stroke: ink, 'stroke-width': 4, 'stroke-linecap': 'round', opacity: '.85',
          }));
        }
      } else if (kind === 'sweat') {
        const slide = (Math.sin(t * 1.4) * 0.5 + 0.5) * 8;
        const x = 156;
        const y = 44 + slide;
        fx.appendChild(el('path', {
          d: `M${x} ${y - 13} C${x + 9} ${y - 2} ${x + 8} ${y + 9} ${x} ${y + 9}` +
             ` C${x - 8} ${y + 9} ${x - 9} ${y - 2} ${x} ${y - 13} Z`,
          fill: '#BFE6FF', opacity: '.9',
        }));
      } else if (kind === 'vein') {
        const g2 = el('g', { stroke: '#E8462E', 'stroke-width': 4.6, 'stroke-linecap': 'round', fill: 'none',
                             opacity: (0.78 + Math.sin(t * 7) * 0.22).toFixed(2) });
        const x = 52, y = 40, a = 13;
        g2.appendChild(el('path', { d: `M${x - a} ${y - a} L${x + a} ${y + a}` }));
        g2.appendChild(el('path', { d: `M${x + a} ${y - a} L${x - a} ${y + a}` }));
        g2.appendChild(el('path', { d: `M${x} ${y - a * 1.25} L${x} ${y + a * 1.25}` }));
        g2.appendChild(el('path', { d: `M${x - a * 1.25} ${y} L${x + a * 1.25} ${y}` }));
        fx.appendChild(g2);
      }
    }

    _drawParticles(h, s, l) {
      const fx = this.g.fx;
      while (fx.firstChild) fx.removeChild(fx.firstChild);
      for (const p of this.particles) {
        const k = p.life / p.max;
        const y = 46 - k * 40;
        const o = Math.sin(k * Math.PI);
        if (p.kind === 'z') {
          const t = el('text', {
            x: 140 + p.x + k * 12, y, fill: step(h, s, l, RAMP.highlight),
            opacity: (o * 0.9).toFixed(2), 'font-size': 16 + k * 10,
            'font-family': 'var(--font, sans-serif)', 'font-weight': 700,
          });
          t.textContent = 'z';
          fx.appendChild(t);
        } else {
          fx.appendChild(el('circle', {
            cx: 100 + p.x + (p.kind === 'spark' ? Math.sin(k * 6) * 10 : 0),
            cy: y, r: (p.kind === 'heart' ? 7 : 5) * (1 - k * 0.4),
            fill: p.kind === 'heart' ? '#F2748C' : step(h, s, l, RAMP.highlight),
            opacity: (o * 0.95).toFixed(2),
          }));
        }
      }
    }
  }

  global.FrenFace = { Face, EMOTIONS, ORDER, ACCENT, FINISHES: Object.keys(FINISH) };
})(window);
