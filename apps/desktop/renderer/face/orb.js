'use strict';
/**
 * fren's face, as real geometry.
 *
 * This exposes exactly the same API as the SVG renderer in face.js — set,
 * pulse, lookAt, lookAway, startTalking, stopTalking, setSpeechLevel, destroy
 * — so the application code does not know or care which one it is talking to.
 * That was the whole point of keeping the character in a parameter space: the
 * renderer is replaceable, the character is not.
 *
 * What real geometry buys, none of which SVG can fake:
 *   - the specular highlight stays put in world space while the body turns,
 *     instead of being painted on and sliding around with it
 *   - the face is an EMISSIVE MAP, so the eyes and mouth are light leaving the
 *     material rather than white shapes sitting on top of it
 *   - a poke displaces vertices, so the surface bulges like something soft
 *     instead of being scaled like a sticker
 *
 * If WebGL is unavailable this module does nothing at all and the SVG face
 * loaded before it stays in place. Failing back to a working renderer matters
 * more than failing loudly.
 */
import * as THREE from '../vendor/three.module.min.js';
import { drawFace } from './face-texture.js';
import { TONE, EXPRESSIONS } from './expressions.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const TAU = Math.PI * 2;

/**
 * Recording, said by the whole character.
 *
 * This replaced a ring drawn around the orb. The ring was the wrong idea for a
 * reason worth keeping written down: anything drawn OUTSIDE the sphere has to
 * be aimed at it, and the sphere moves — it tracks the pointer and idles with a
 * bob — so the ring was either chasing it every frame or sitting slightly off,
 * and even when it was concentric to a quarter of a pixel it still read as low,
 * because a face's optical centre is not its geometric one.
 *
 * The orb pulsing is immune to all of that. There is nothing to align: the
 * indicator IS the character.
 *
 * Slow — slower than a heartbeat — because this runs for as long as the
 * microphone is open and anything faster becomes an alarm.
 */
const REC_HZ = 0.62;
// Scratch colours for the recording pulse. Refilled every frame from the
// palette module's RECORDING pair — fixed record red, deliberately NOT the
// chosen palette; see the note beside it.
const _recLow = new THREE.Color();
const _recHigh = new THREE.Color();
const REC = (typeof window !== 'undefined' && window.FrenPalette &&
  window.FrenPalette.RECORDING) ||
  (typeof require === 'function' && (() => { try { return require('./palette.js').RECORDING; } catch { return null; } })()) ||
  { low: 0xd93425, high: 0xff6247, rough: 0.18, sheen: 0.60 };
// The shipped look — stops, lights, coat — owned by the palette module so the
// dashboard's sliders, the sanitizer and these uniforms can never disagree.
// The literal fallback matches it for the pathological no-palette boot.
const LOOK = (typeof window !== 'undefined' && window.FrenPalette &&
  window.FrenPalette.ORB_LOOK) ||
  { goldH: -3.5, goldS: 60, goldL: 9, coralH: -16, coralS: 54, coralL: -4,
    ambient: 2.6, key: 0.7, fill: 1.0, clearcoat: 0.24, coatRough: 0.29 };


/** Parameters that cross-fade when the expression changes. */
const EASED = ['lit', 'lidTop', 'eyeScale', 'eyeAsym', 'mouthW', 'mouthOpen', 'mouthCurve', 'mouthWave'];

class Orb {
  constructor(mount, opts = {}) {
    const size = opts.size || 108;
    this.mount = mount;

    this.motionQuery = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this.reduced = !!(this.motionQuery && this.motionQuery.matches);
    if (this.motionQuery) {
      this._onMotion = (e) => { this.reduced = e.matches; this._wake(); };
      this.motionQuery.addEventListener('change', this._onMotion);
    }

    // Start dark and shut. If anything upstream fails, fren must look like it
    // is NOT watching — the privacy signal has to fail closed.
    this.emotion = 'private';
    this.p = { ...EXPRESSIONS.private };
    this.target = { ...EXPRESSIONS.private };
    this.p.blink = this.target.blink = 0;

    this.gaze = { x: 0, y: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.talkPhase = -1;
    this.speechLevel = null;
    this.blinkPhase = -1;
    this.blinkQueue = 0;
    this.listenLevel = null;
    this.nextBlink = 2 + Math.random() * 3;
    this.wobbleAmt = 0;
    this.squashAmt = 0;
    this.nodAmt = 0;
    this.shakeAmt = 0;
    // Scroll-to-resize spins the sphere. Two numbers, not one: the velocity is
    // what a scroll adds to, and the angle is what it turns into. Both bleed
    // off, so the face always comes back to front — a ball that stopped
    // wherever the wheel left it would spend most of its life facing away.
    this.rollVel = 0;
    this.rollAngle = 0;
    // Shake. One amount, plus a set of frequencies and phases re-rolled every
    // time it is kicked. The randomness lives in the CHARACTER of the wobble
    // rather than in a jittered amplitude: jittering the amplitude reads as
    // dropped frames, while jittering the frequencies reads as a real object
    // wobbling in a way you cannot predict.
    this.jiggleAmt = 0;
    this.jiggleWave = null;
    this.t = 0;
    this.raf = null;

    this._build(mount, size);
    this._paint();
    this._loop = this._loop.bind(this);
    this._wake();
  }

  // ---------------------------------------------------------------- scene --
  _build(mount, size) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${size}px;height:${size}px;display:block`;
    mount.appendChild(canvas);
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // Supersample. The orb is small and its silhouette is the only hard edge
    // in the whole window, so rendering above the device ratio and letting the
    // compositor downsample buys a visibly cleaner curve for very little --
    // 123px at 3x is 369px, which is nothing for one sphere.
    this.renderer.setPixelRatio(Math.min(3, (window.devicePixelRatio || 1) * 1.5));
    this.renderer.setSize(size, size, false);
    // No filmic tone mapping: it desaturates #FF8A00 off the brand ramp.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearAlpha(0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    // Framed so the sphere fills the canvas the way the SVG face did. At the
    // old distance it occupied under half the height, which is most of why it
    // read as small. The view centre sits below the sphere centre to leave the
    // contact shadow in frame.
    this.camera.position.set(0, -0.12, 5.25);
    this.camera.lookAt(0, -0.12, 0);

    this.scene.environment = this._studioEnv();

    // The face, drawn to a canvas and wrapped on as an equirectangular map.
    this.faceCanvas = document.createElement('canvas');
    this.faceCanvas.width = this.faceCanvas.height = 1024;
    this.equirect = document.createElement('canvas');
    this.equirect.width = 2048;
    this.equirect.height = 1024;
    this.eqCtx = this.equirect.getContext('2d');

    this.faceTex = new THREE.CanvasTexture(this.equirect);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceTex.wrapS = THREE.RepeatWrapping;
    this.faceTex.offset.x = 0.25;      // bring the face round to the front

    this.material = new THREE.MeshPhysicalMaterial({
      color: TONE.base.color,
      roughness: TONE.base.rough,
      metalness: 0,
      // Not 1 any more. A full clearcoat with no environment map steals the
      // base layer's energy at grazing angles and reflects nothing back — a
      // black mirror — which is what kept the orb's lower rim dark brown no
      // matter how bright the coral under it was. And well under a half now:
      // the reference this body is matched to is nearly matte, so the coat is
      // just enough for one soft catchlight to say "sphere".
      clearcoat: LOOK.clearcoat,
      clearcoatRoughness: LOOK.coatRough,
      sheen: TONE.base.sheen,
      sheenColor: new THREE.Color(0xffc06a),
      emissive: new THREE.Color(0xffffff),
      emissiveMap: this.faceTex,
      emissiveIntensity: 1.45,
    });

    // Jelly: displace vertices along their normals so the surface bulges.
    this.uWobble = { value: 0 };
    this.uSquash = { value: 0 };
    this.uTime = { value: 0 };
    // The gradient stops as offsets from the base, live-tunable (h, s, l in
    // 0..1 turns / fractions). Defaults are the shipped look.
    // Chosen by eye in a live tuning session against a reference image —
    // which settled in one evening what four derivations had failed to.
    this.uGoldOff = { value: new THREE.Vector3(LOOK.goldH / 360, LOOK.goldS / 100, LOOK.goldL / 100) };
    this.uCoralOff = { value: new THREE.Vector3(LOOK.coralH / 360, LOOK.coralS / 100, LOOK.coralL / 100) };
    // Re-rolled on every shake, so no two look alike.
    this.uSeed = { value: 0 };
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uAmount = this.uWobble;
      shader.uniforms.uSquash = this.uSquash;
      shader.uniforms.uSeed = this.uSeed;
      shader.uniforms.uGoldOff = this.uGoldOff;
      shader.uniforms.uCoralOff = this.uCoralOff;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; uniform float uAmount; uniform float uSquash;
          uniform float uSeed;
          varying vec3 vGradN;`)
        // The gradient's compass. View-space normals, so the warm corner stays
        // pinned to the screen's top-left however the sphere rolls or the gaze
        // turns — it reads as light falling on fren, not as paint on it.
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          vGradN = normalMatrix * objectNormal;`)
        // Three axes rather than two, so a wobble travels around the sphere
        // instead of rippling in one plane, and a per-shake seed so the surface
        // deforms differently each time instead of the same standing wave
        // getting louder. The weights still sum to 1.0, so uAmount means the
        // same displacement it always did and the existing poke is untouched.
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float w = sin(position.y * 4.2 + uTime * 9.0  + uSeed)       * 0.45
                  + sin(position.x * 3.1 - uTime * 7.3  + uSeed * 1.7) * 0.32
                  + sin(position.z * 5.3 + uTime * 11.6 + uSeed * 2.3) * 0.23;
          transformed += normal * w * uAmount;
          transformed.xz *= 1.0 + uSquash;
          transformed.y  *= 1.0 - uSquash;`);

      /*
       * The body is a gradient, not a colour: gold falling in from the top
       * left, coral pooling at the bottom right. Crucially both stops are
       * DERIVED from the one animated base colour, in the shader, per frame —
       * hue rotated a few degrees either way — rather than being two more
       * uniforms someone has to remember to set. Everything that already
       * moves the base keeps working untouched: moods brighten it, listening
       * pulses it toward gold, sleep drains it to grey (where saturation is
       * near zero, so the hue swing quietly vanishes and asleep stays grey).
       */
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vGradN;
          uniform vec3 uGoldOff;
          uniform vec3 uCoralOff;
          vec3 frenHsl(vec3 c) {
            float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
            float l = (mx + mn) * 0.5, d = mx - mn, h = 0.0, s = 0.0;
            if (d > 1e-5) {
              s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
              if (mx == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
              else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
              else                h = (c.r - c.g) / d + 4.0;
              h /= 6.0;
            }
            return vec3(h, s, l);
          }
          float frenHue(float p, float q, float t) {
            t = fract(t);
            if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
            if (t < 0.5)       return q;
            if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
            return p;
          }
          vec3 frenRgb(vec3 hsl) {
            float s = clamp(hsl.y, 0.0, 1.0), l = clamp(hsl.z, 0.0, 1.0);
            if (s < 1e-5) return vec3(l);
            float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
            float p = 2.0 * l - q;
            return vec3(frenHue(p, q, hsl.x + 1.0 / 3.0),
                        frenHue(p, q, hsl.x),
                        frenHue(p, q, hsl.x - 1.0 / 3.0));
          }`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
          // The colour work happens in sRGB, not in the linear values the
          // shader is handed. A hue turned toward red at constant LINEAR
          // lightness loses perceived brightness — that is how the coral
          // corner kept coming out maroon — and these offsets were chosen by
          // eye against an sRGB reference, so sRGB is the space they mean.
          vec3 frenBase = frenHsl(pow(diffuse, vec3(1.0 / 2.2)));
          // The stops apply to EVERYTHING the base does, recording included.
          // The pulse used to collapse the gradient, because the original
          // offsets rotated the top-left twenty degrees warmer and turned
          // record red back into orange. The tuned offsets barely move the
          // hue and carry the look in saturation — so a recording fren keeps
          // the same body it always has, just in red, and a customised look
          // records in its own version of red.
          vec3 frenGold  = frenBase + uGoldOff;
          vec3 frenCoral = frenBase + uCoralOff;
          // Centre of the disc sits at the midpoint; the stops arrive just
          // before the rim, along the same up-left diagonal as the key light.
          vec3 frenNv = normalize(vGradN);
          float frenT = smoothstep(0.0, 1.0,
            0.5 + 0.62 * dot(frenNv.xy, vec2(-0.566, 0.824)));
          vec4 diffuseColor =
            vec4(pow(frenRgb(mix(frenCoral, frenGold, frenT)), vec3(2.2)), opacity);`);
    };

    this.orb = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), this.material);
    this.scene.add(this.orb);

    // Bright and even, so the gradient reads as the body's colour. With the
    // old 0.35 ambient the coral corner sat in the key light's shade and came
    // out brown — the reference the palette is matched to is nearly flat-lit,
    // its form carried by the colour ramp rather than by shading.
    this.ambient = new THREE.AmbientLight(0xffffff, LOOK.ambient);
    this.scene.add(this.ambient);
    // The key SHAPES the sphere. High and up-left, and it casts nothing --
    // from up there the shadow would land far below the frame.
    this.key = new THREE.DirectionalLight(0xfff1dc, LOOK.key);
    this.key.position.set(-2.2, 4.2, 3.0);
    this.key.castShadow = false;
    this.scene.add(this.key);
    // A fill from the coral corner, so the gradient's far stop is lit by
    // something and reads as colour rather than as shade. Warm-pink on
    // purpose: a white fill would wash the coral toward orange.
    this.fill = new THREE.DirectionalLight(0xffd2c2, LOOK.fill);
    this.fill.position.set(2.4, -2.6, 2.6);
    this.fill.castShadow = false;
    this.scene.add(this.fill);

    // Nothing casts a shadow in the scene. A plane can only receive a shadow
    // ONTO itself, which is the wrong shape entirely -- what the orb needs is a
    // halo hugging its own silhouette. CSS drop-shadow does that from the
    // canvas alpha (see styles.css), so it traces the outline exactly and keeps
    // tracing it while the surface bulges from a poke, and costs no shadow map.

    this.toneNow = new THREE.Color(TONE.grey.color);
    this.toneTo = new THREE.Color(TONE.grey.color);
    this.matNow = { rough: TONE.grey.rough, sheen: TONE.grey.sheen };
    this.matTo = { ...this.matNow };
  }

  /** A cheap studio: bright above, warm bounce below, for the clearcoat. */
  _studioEnv() {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0.0, '#ffffff');
    g.addColorStop(0.42, '#c9cfd8');
    g.addColorStop(0.62, '#4a4038');
    g.addColorStop(1.0, '#2a1d12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _paint() {
    drawFace(this.faceCanvas, this.p);
    // Black everywhere the face is not: an emissive map reads RGB only, so
    // black means no emission.
    this.eqCtx.fillStyle = '#000';
    this.eqCtx.fillRect(0, 0, this.equirect.width, this.equirect.height);
    const w = this.equirect.width * (112 / 360);
    const h = this.equirect.height * (100 / 180);
    this.eqCtx.drawImage(this.faceCanvas,
      this.equirect.width / 2 - w / 2, this.equirect.height / 2 - h / 2, w, h);
    this.faceTex.needsUpdate = true;
  }

  // ----------------------------------------------------------- public API --
  set(name, opts = {}) {
    const preset = EXPRESSIONS[name];
    if (!preset) return;
    this.emotion = name;
    for (const k of EASED) this.target[k] = preset[k] ?? (k === 'lit' ? 1 : 0);
    Object.assign(this.target, opts.override || {});
    this.target.tone = preset.tone;

    const tone = this.tone(preset.tone);
    this.toneTo.setHex(tone.color);
    this.matTo.rough = tone.rough;
    this.matTo.sheen = tone.sheen;

    if (opts.immediate || this.reduced) {
      for (const k of EASED) this.p[k] = this.target[k];
      this.toneNow.copy(this.toneTo);
      this.matNow.rough = this.matTo.rough;
      this.matNow.sheen = this.matTo.sheen;
      this._paint();
    }
    this._wake();
  }

  lookAt(nx, ny) {
    this.gazeTarget = { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
    this._wake();
  }

  lookAway() {
    this.gazeTarget = { x: 0, y: 0 };
    this._wake();
  }

  startTalking() { this.talkPhase = 0; this._wake(); }

  stopTalking() {
    this.talkPhase = -1;
    this.speechLevel = null;
    // Hand the mouth back to whatever expression is showing.
    const e = EXPRESSIONS[this.emotion] || EXPRESSIONS.calm;
    this.target.mouthOpen = e.mouthOpen ?? 0;
    this.target.mouthW = e.mouthW ?? 1;
    this.target.mouthCurve = e.mouthCurve ?? 0.5;
    this._wake();
  }

  /**
   * Show that the microphone is open, and that it is hearing something.
   *
   * Pass a level 0..1 to modulate the glow with the voice; pass null to stop.
   * The level is what makes this unmistakable: a state change alone could be
   * anything, but a face that brightens when you speak is obviously listening
   * to YOU.
   */
  /**
   * Give the sphere a shove, in radians per second.
   *
   * Positive rolls the top away from you, which is the direction a ball turns
   * when it rolls TOWARD you across a desk — so growing and rolling forward
   * are the same gesture rather than two things happening at once.
   */
  roll(v) {
    // Spinning is decoration; resizing is the function. Someone who asked the
    // system for less motion still gets the size change, without the tumble.
    if (this.reduced) return;
    this.rollVel += v;
    // Capped, or a hard trackpad flick spins it into a blur that reads as a
    // glitch rather than as a ball.
    this.rollVel = Math.max(-26, Math.min(26, this.rollVel));
    this._wake();
  }

  /**
   * The palette in force — the chosen one if there is one, else the original.
   *
   * Resolved per lookup rather than copied at construction, so a colour change
   * reaches an orb that already exists. There is only ever one orb, and it is
   * built before the setting has been read.
   */
  tone(name) {
    const set = this.tones || TONE;
    return set[name] || set.base || TONE.base;
  }

  /**
   * Wear a different colour.
   *
   * Only the identity family moves; sad, cross and asleep are meanings and
   * palette.js leaves them alone. The current tone is re-applied immediately
   * rather than waiting for the next expression change, or fren would sit in
   * its old colour until something happened to it.
   */
  setPalette(hex) {
    const P = (typeof window !== 'undefined') && window.FrenPalette;
    if (!P) return;
    this.tones = P.tonesFrom(hex);
    this.material.sheenColor.setHex(P.sheenColorFrom(hex));
    const tone = this.tone(this.target.tone || 'base');
    this.toneTo.setHex(tone.color);
    this.matTo.rough = tone.rough;
    this.matTo.sheen = tone.sheen;
    this._wake();
  }

  /**
   * Shaken. Wobble like something with jelly in it.
   *
   * `power` is 0..1 and ADDS, so a sustained shake keeps topping the energy up
   * rather than restarting the animation on every reversal — restarting is what
   * makes a repeated effect look like a stutter.
   *
   * The wave is re-rolled on every kick: six independent frequencies, all
   * incommensurate, so nothing lines up into a visible beat and no two shakes
   * are the same shape. The poke keeps its single tidy sine; this is
   * deliberately the messy relative of it.
   */
  shake(power = 1) {
    // Motion is the whole effect, so under prefers-reduced-motion it simply is
    // not done. There is no honest quieter version of "wobbles wildly".
    if (this.reduced) return;
    const p = clamp(power, 0, 1);
    this.jiggleAmt = Math.min(1, this.jiggleAmt + p * 0.75);
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    this.jiggleWave = {
      // Spread across a range rather than picked around one value: a fast
      // wobble on top of a slow one is what reads as floppy.
      fa: r(11, 17), fb: r(19, 27), fc: r(24, 34),
      fd: r(13, 21), fe: r(26, 36), ff: r(9, 15),
      pa: r(0, TAU), pb: r(0, TAU), pc: r(0, TAU),
      pd: r(0, TAU), pe: r(0, TAU), pf: r(0, TAU),
      // Which way it mostly swings, so one shake favours a lean and the next a
      // tumble.
      tilt: r(0.5, 1.4), yaw: r(0.5, 1.4), pitch: r(0.3, 1.0),
      seed: r(0, 40),
    };
    this._wake();
  }

  /** Re-render at a new pixel size. The camera is square, so nothing else moves. */
  resize(px) {
    const n = Math.max(1, Math.round(px));
    this.canvas.style.width = `${n}px`;
    this.canvas.style.height = `${n}px`;
    this.renderer.setSize(n, n, false);
    this._wake();
  }

  /**
   * Apply a look — the dashboard's "Advanced look" setting, or the shipped
   * default when the customisation is cleared. Fields already pass through
   * palette.js sanitizeLook before they get here, so this just applies.
   * Roughness and sheen are deliberately absent: the mood system owns them
   * per-expression and rewrites them every frame.
   */
  tune(t) {
    const look = { ...LOOK, ...(t || {}) };
    this.uGoldOff.value.set(look.goldH / 360, look.goldS / 100, look.goldL / 100);
    this.uCoralOff.value.set(look.coralH / 360, look.coralS / 100, look.coralL / 100);
    this.ambient.intensity = look.ambient;
    this.key.intensity = look.key;
    this.fill.intensity = look.fill;
    this.material.clearcoat = look.clearcoat;
    this.material.clearcoatRoughness = look.coatRough;
    this._wake();
  }

  setListening(level) {
    const on = level !== null && level !== undefined;
    if (on !== (this.listenLevel !== null && this.listenLevel !== undefined)) {
      // Recording wears the fixed record red (see the pulse below) — this is
      // what reduced-motion users see steadily instead of the beat, so it has
      // to be the same red, not the palette's listening tone. Everything else
      // still comes from the chosen palette via this.tone().
      const tone = on
        ? { color: REC.low, rough: REC.rough, sheen: REC.sheen }
        : this.tone((EXPRESSIONS[this.emotion] || EXPRESSIONS.calm).tone);
      this.toneTo.setHex(tone.color);
      this.matTo.rough = tone.rough;
      this.matTo.sheen = tone.sheen;
    }
    this.listenLevel = on ? clamp(level, 0, 1) : null;
    this._wake();
  }

  /** Drive the mouth from real audio amplitude, 0..1. */
  setSpeechLevel(v) {
    this.speechLevel = v === null ? null : clamp(v, 0, 1);
    this._wake();
  }

  pulse(kind = 'bounce') {
    switch (kind) {
      case 'squash': this.squashAmt = 0.085; break;
      case 'stretch': this.squashAmt = -0.075; break;
      case 'nod': this.nodAmt = 0.42; break;
      case 'shake': this.shakeAmt = 0.42; break;
      case 'blink': this.blinkPhase = 0; break;
      default: this.wobbleAmt = 0.05; this.squashAmt = 0.06; break;
    }
    this._wake();
  }

  destroy() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.motionQuery && this._onMotion) {
      this.motionQuery.removeEventListener('change', this._onMotion);
    }
    this.orb.geometry.dispose();
    this.material.dispose();
    this.faceTex.dispose();
    this.renderer.dispose();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }

  // -------------------------------------------------------------- the loop --
  _wake() {
    if (this.raf === null) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this._loop);
    }
  }

  _atRest() {
    if (this.blinkPhase >= 0 || this.talkPhase >= 0 || this.speechLevel !== null) return false;
    if (this.listenLevel !== null) return false;
    if (Math.abs(this.wobbleAmt) > 0.001 || Math.abs(this.squashAmt) > 0.001) return false;
    if (Math.abs(this.nodAmt) > 0.001 || Math.abs(this.shakeAmt) > 0.001) return false;
    if (this.jiggleAmt > 0.001) return false;   // or a wobble freezes mid-wobble
    if (Math.abs(this.gaze.x - this.gazeTarget.x) > 0.002) return false;
    if (Math.abs(this.gaze.y - this.gazeTarget.y) > 0.002) return false;
    for (const k of EASED) if (Math.abs(this.target[k] - this.p[k]) > 0.001) return false;
    return true;
  }

  _loop(now) {
    // Clamped at BOTH ends. Every decay in this loop is Math.pow(k, dt) with
    // k < 1, so a negative dt does not slow them down — it inverts them, and
    // the amounts grow without bound instead of settling. One frame of that
    // sent the wobble to 800 and the sphere's scale negative.
    //
    // _wake() writes performance.now() into `last` while the loop is otherwise
    // clocked by requestAnimationFrame, and those agree today; this is here so
    // that a clock that ever disagrees costs a dropped frame rather than the
    // character turning inside out.
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.t += dt;
    this.uTime.value = this.t;

    let dirty = false;

    // Expression cross-fade.
    const k = Math.min(1, dt * 7);
    for (const key of EASED) {
      const d = this.target[key] - this.p[key];
      if (Math.abs(d) > 0.0008) { this.p[key] += d * k; dirty = true; }
      else if (this.p[key] !== this.target[key]) { this.p[key] = this.target[key]; dirty = true; }
    }

    // Speech. Real audio wins; the synthetic rhythm is the fallback so the
    // mouth still moves when no voice key is configured.
    if (this.speechLevel !== null) {
      const lv = this.speechLevel;
      this.p.mouthOpen = 0.05 + lv * 0.55;
      this.p.mouthW = 0.74 + lv * 0.40;
      dirty = true;
    } else if (this.talkPhase >= 0) {
      this.talkPhase += dt;
      const tp = this.talkPhase;
      const phrase = Math.sin(tp * 0.62) * 0.5 + 0.5;
      const gate = phrase > 0.16 ? 1 : 0;
      const syllable = Math.pow(Math.sin(tp * 8.4) * 0.5 + 0.5, 0.65);
      const stress = 0.62 + 0.38 * (Math.sin(tp * 3.1 + Math.sin(tp * 1.7) * 2.0) * 0.5 + 0.5);
      const open = gate * syllable * stress;
      this.p.mouthOpen = 0.04 + open * 0.52;
      this.p.mouthW = 0.74 + open * 0.42;
      dirty = true;
    }

    // Blinking. Lids shut fast and open slower, and about one in five comes
    // as a pair — which is what stops it reading as a metronome.
    if (!this.reduced) {
      this.nextBlink -= dt;
      if (this.blinkPhase < 0 && this.nextBlink <= 0 &&
          this.target.lit > 0.4 && this.target.lidTop < 0.62 && this.talkPhase < 0) {
        this.blinkPhase = 0;
        this.blinkQueue = Math.random() < 0.22 ? 1 : 0;
        this.nextBlink = 2.6 + Math.random() * 4.8;
      }
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt;
      const DOWN = 0.055;
      const UP = 0.115;
      if (this.blinkPhase < DOWN) this.p.blink = this.blinkPhase / DOWN;
      else if (this.blinkPhase < DOWN + UP) this.p.blink = 1 - (this.blinkPhase - DOWN) / UP;
      else {
        this.p.blink = 0;
        this.blinkPhase = this.blinkQueue > 0 ? (this.blinkQueue--, 0) : -1;
      }
      dirty = true;
    }

    if (dirty) this._paint();

    // Body colour follows the mood, eased in colour space.
    const ck = Math.min(1, dt * 3.4);
    this.toneNow.lerp(this.toneTo, ck);
    this.matNow.rough += (this.matTo.rough - this.matNow.rough) * ck;
    this.matNow.sheen += (this.matTo.sheen - this.matNow.sheen) * ck;
    // Lit means watching. Drained means it is not, and that has to be true of
    // the whole object, not just the two eyes.
    this.material.color.copy(DRAINED).lerp(this.toneNow, Math.min(1, this.p.lit * 1.05));

    // Recording: the whole orb breathes, deepening in colour and back.
    //
    // Applied AFTER the drained lerp above and deliberately not gated by `lit`.
    // That gate is what made the previous indicator useless while fren was
    // paused — a paused face is drained, so anything scaled by its own colour
    // fades out exactly when you most need to know the microphone is open.
    // Recording is not the same fact as watching and does not take its cue
    // from it.
    //
    // The eyes stay shut while paused regardless, so a pulsing dark orb still
    // cannot be mistaken for a watching one.
    if (this.listenLevel !== null && !this.reduced) {
      const beat = 0.5 - 0.5 * Math.cos(this.t * TAU * REC_HZ);

      // RECORD RED, replacing the drained colour above rather than modifying
      // it — and replacing the chosen palette too, which is deliberate and a
      // reversal. The pulse used to travel base-to-hearing "so a teal fren
      // pulses teal", and after the palette softened, that travel ran from
      // orange to pale peach: half of every cycle was a washed-out colour and
      // the whole state read as GREYING, not recording. An open microphone is
      // the one fact that borrows its colour from the world instead of from
      // fren — red pulsing sphere, record button, no explanation needed. Both
      // ends are red, so the state is red all the way through the beat.
      //
      // Still not scaled by `lit`, so a PAUSED fren burns red while the
      // microphone is open: a drained orb quietly recording is the thing this
      // app must never be.
      this.material.color.copy(_recLow.setHex(REC.low)).lerp(_recHigh.setHex(REC.high), beat);
    }
    this.material.roughness = this.matNow.rough;
    this.material.sheen = this.matNow.sheen * this.p.lit;

    // While listening, the face's own light tracks the voice. A floor keeps it
    // visibly lit through the pauses between words, so silence does not read
    // as the microphone having closed.
    // The recording breathe, worked out here and APPLIED further down. Scale has
    // two owners — this and the shake — and whichever wrote it last used to
    // simply win. Composed in one place instead, below.
    let breathe = 1;
    if (this.listenLevel !== null) {
      // The voice still rides on top: the pulse says the microphone is OPEN,
      // the level says it can hear you. Two different facts, both worth having.
      const beat = this.reduced ? 0.5 : 0.5 - 0.5 * Math.cos(this.t * TAU * REC_HZ);
      this.material.emissiveIntensity = 1.45 + 0.30 + beat * 0.55 + this.listenLevel * 1.2;
      breathe = 1 + beat * 0.028 + this.listenLevel * 0.014;
    } else if (this.material.emissiveIntensity !== 1.45) {
      this.material.emissiveIntensity = 1.45;
    }

    // Impulses ring out like something soft.
    this.wobbleAmt *= Math.pow(0.06, dt);
    this.squashAmt *= Math.pow(0.02, dt);
    this.nodAmt *= Math.pow(0.02, dt);
    this.shakeAmt *= Math.pow(0.02, dt);
    // Shake decay, slower than the poke on purpose: a poke is an
    // acknowledgement and should be over before you have finished clicking,
    // while a shake carries on after you stop, because the settling IS the joke.
    this.jiggleAmt *= Math.pow(0.10, dt);
    if (this.jiggleAmt < 0.002) { this.jiggleAmt = 0; this.jiggleWave = null; }

    const j = this.jiggleAmt;
    const w = this.jiggleWave;
    let jTilt = 0, jYaw = 0, jPitch = 0, jSquash = 0, jx = 0, jy = 0;
    if (j > 0 && w) {
      const t = this.t;
      // Two frequencies per axis, one fast and one slow. A single sine per axis
      // is a pendulum; two that never line up is something floppy.
      //
      // The amplitudes were measured rather than guessed: a first pass peaked at
      // 20 degrees of yaw and 4% squash — LESS squash than a single click gets.
      jYaw   = (Math.sin(t * w.fa + w.pa) + 0.55 * Math.sin(t * w.fb + w.pb)) * j * 0.62 * w.yaw;
      jTilt  = (Math.sin(t * w.fc + w.pc) + 0.50 * Math.sin(t * w.fd + w.pd)) * j * 0.52 * w.tilt;
      jPitch = Math.sin(t * w.fe + w.pe) * j * 0.36 * w.pitch;
      jSquash = Math.sin(t * w.ff + w.pf) * j * 0.15;
      // A little travel too, so it is not pivoting about a fixed point — a
      // shaken object moves as well as turns.
      jx = Math.sin(t * w.fb + w.pc) * j * 0.05;
      jy = Math.sin(t * w.fd + w.pe) * j * 0.04;
      this.uSeed.value = w.seed;
    }

    this.uWobble.value = this.wobbleAmt + j * 0.15;
    this.uSquash.value = this.squashAmt + jSquash;

    // Scale, composed from both its owners.
    //
    // Drawing in while wobbling is not decoration: the sphere is framed to fill
    // the canvas with 41% of its radius spare, and only 0.287 of that above
    // centre, while the bulge and the squash MULTIPLY. At full amplitude the
    // silhouette would push past the top edge and the wobble would clip instead
    // of wobble. Pulling it in buys the room back, and a ball drawing into
    // itself as it is rattled looks deliberate.
    this.orb.scale.setScalar(breathe * (1 - j * 0.10));

    // The body TURNS toward the pointer, and takes the highlight with it.
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * Math.min(1, dt * 5);
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * Math.min(1, dt * 5);
    this.orb.rotation.y = this.gaze.x * 0.42 + Math.sin(this.t * 26) * this.shakeAmt * 0.5 + jYaw;
    // Roll about the view axis. Nothing else uses it, and a side-to-side lean is
    // most of what makes something look shaken rather than merely turned.
    this.orb.rotation.z = jTilt;
    // Roll. The spin runs down on its own, and the angle is pulled toward the
    // NEAREST WHOLE TURN rather than toward zero — which is the whole trick.
    // Pulling toward zero caps the tumble at whatever the pull allows (it
    // topped out around 45 degrees, a tilt rather than a roll) and fights the
    // spin the entire time. Pulling toward the nearest turn lets it rotate as
    // far as the shove carries it, complete however many turns that is, and
    // still finish exactly face-front.
    //
    // The pull fades in as the spin dies, so it never drags on a ball that is
    // still moving.
    this.rollVel *= Math.pow(0.02, dt);
    this.rollAngle += this.rollVel * dt;
    const home = Math.round(this.rollAngle / TAU) * TAU;
    const settle = Math.min(1, dt * 8 * (1 - Math.min(1, Math.abs(this.rollVel) / 2)));
    this.rollAngle += (home - this.rollAngle) * settle;
    if (Math.abs(this.rollVel) < 0.01) this.rollVel = 0;
    // Snap the last hair, so a settled ball is exactly front-on and the loop
    // can go back to sleep under reduced motion.
    if (this.rollVel === 0 && Math.abs(this.rollAngle - home) < 0.002) this.rollAngle = 0;
    this.orb.rotation.x = jPitch + this.gaze.y * 0.26 + Math.sin(this.t * 22) * this.nodAmt * 0.4
      + this.rollAngle;
    this.orb.position.x = this.gaze.x * 0.10 + jx;
    this.orb.position.y = -this.gaze.y * 0.07 + jy +
      (this.reduced ? 0 : Math.sin(this.t * 1.4) * 0.022);


    this.renderer.render(this.scene, this.camera);

    // Under reduced motion a settled face costs nothing: stop the loop
    // entirely rather than re-rendering an identical frame forever.
    if (this.reduced && this._atRest()) { this.raf = null; return; }
    this.raf = requestAnimationFrame(this._loop);
  }
}

const DRAINED = new THREE.Color(0x46464a);



// Replace the SVG renderer only once we know WebGL actually works here. If it
// does not, face.js stays in place and nothing downstream notices.
function webglWorks() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

if (webglWorks()) {
  window.FrenFace = Object.assign({}, window.FrenFace, {
    Face: Orb, EXPRESSIONS, TONE, ORDER: Object.keys(EXPRESSIONS), renderer: '3d',
  });
} else if (window.FrenFace) {
  window.FrenFace.renderer = 'svg';
}

export { Orb, EXPRESSIONS, TONE };
