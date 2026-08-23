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
      clearcoat: 1,
      clearcoatRoughness: 0.06,
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
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uAmount = this.uWobble;
      shader.uniforms.uSquash = this.uSquash;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; uniform float uAmount; uniform float uSquash;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float w = sin(position.y * 4.2 + uTime * 9.0) * 0.6
                  + sin(position.x * 3.1 - uTime * 7.3) * 0.4;
          transformed += normal * w * uAmount;
          transformed.xz *= 1.0 + uSquash;
          transformed.y  *= 1.0 - uSquash;`);
    };

    this.orb = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), this.material);
    this.scene.add(this.orb);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    // The key SHAPES the sphere. High and up-left, and it casts nothing --
    // from up there the shadow would land far below the frame.
    this.key = new THREE.DirectionalLight(0xfff1dc, 3.1);
    this.key.position.set(-2.2, 4.2, 3.0);
    this.key.castShadow = false;
    this.scene.add(this.key);

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

  /** Re-render at a new pixel size. The camera is square, so nothing else moves. */
  resize(px) {
    const n = Math.max(1, Math.round(px));
    this.canvas.style.width = `${n}px`;
    this.canvas.style.height = `${n}px`;
    this.renderer.setSize(n, n, false);
    this._wake();
  }

  setListening(level) {
    const on = level !== null && level !== undefined;
    if (on !== (this.listenLevel !== null && this.listenLevel !== undefined)) {
      const tone = TONE[on ? 'hearing' : (EXPRESSIONS[this.emotion] || EXPRESSIONS.calm).tone] || TONE.base;
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
    if (Math.abs(this.gaze.x - this.gazeTarget.x) > 0.002) return false;
    if (Math.abs(this.gaze.y - this.gazeTarget.y) > 0.002) return false;
    for (const k of EASED) if (Math.abs(this.target[k] - this.p[k]) > 0.001) return false;
    return true;
  }

  _loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
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

      // IN sRGB, explicitly. THREE.Color stores linear-sRGB, so getHSL and
      // setHSL without a colour space hand you linear values — a drained grey
      // reads as lightness 0.08 rather than the 0.32 it looks like, and a
      // modest-sounding "+0.055 lightness" is then a huge visible jump. The
      // first version of this pulse was written in linear by accident and lit
      // a paused orb up like a lamp.
      this.material.color.getHSL(_hsl, THREE.SRGBColorSpace);

      // The hue is TAKEN, not blended: a drained orb is a blue-grey and
      // saturating that gives a purple orb. Saturation is the pulse — which is
      // the point, since saturation is not brightness, and brightness is what
      // would make a paused fren look awake.
      //
      // The floor is below the orb's own saturation so there is somewhere to
      // swing FROM. A lit orange is already fully saturated: without pulling it
      // down first there is no room above it and the pulse would be invisible
      // exactly where the orb is most colourful.
      this.material.color.setHSL(
        REC_HUE,
        Math.min(1, _hsl.s * 0.45 + beat * 0.58),
        Math.min(0.64, _hsl.l + beat * 0.075),
        THREE.SRGBColorSpace,
      );
    }
    this.material.roughness = this.matNow.rough;
    this.material.sheen = this.matNow.sheen * this.p.lit;

    // While listening, the face's own light tracks the voice. A floor keeps it
    // visibly lit through the pauses between words, so silence does not read
    // as the microphone having closed.
    if (this.listenLevel !== null) {
      // The voice still rides on top: the pulse says the microphone is OPEN,
      // the level says it can hear you. Two different facts, both worth having.
      const beat = this.reduced ? 0.5 : 0.5 - 0.5 * Math.cos(this.t * TAU * REC_HZ);
      this.material.emissiveIntensity = 1.45 + 0.30 + beat * 0.55 + this.listenLevel * 1.2;
      this.orb.scale.setScalar(1 + beat * 0.028 + this.listenLevel * 0.014);
    } else if (this.material.emissiveIntensity !== 1.45) {
      this.material.emissiveIntensity = 1.45;
      this.orb.scale.setScalar(1);
    }

    // Impulses ring out like something soft.
    this.wobbleAmt *= Math.pow(0.06, dt);
    this.squashAmt *= Math.pow(0.02, dt);
    this.nodAmt *= Math.pow(0.02, dt);
    this.shakeAmt *= Math.pow(0.02, dt);
    this.uWobble.value = this.wobbleAmt;
    this.uSquash.value = this.squashAmt;

    // The body TURNS toward the pointer, and takes the highlight with it.
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * Math.min(1, dt * 5);
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * Math.min(1, dt * 5);
    this.orb.rotation.y = this.gaze.x * 0.42 + Math.sin(this.t * 26) * this.shakeAmt * 0.5;
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
    this.orb.rotation.x = this.gaze.y * 0.26 + Math.sin(this.t * 22) * this.nodAmt * 0.4
      + this.rollAngle;
    this.orb.position.x = this.gaze.x * 0.10;
    this.orb.position.y = -this.gaze.y * 0.07 +
      (this.reduced ? 0 : Math.sin(this.t * 1.4) * 0.022);


    this.renderer.render(this.scene, this.camera);

    // Under reduced motion a settled face costs nothing: stop the loop
    // entirely rather than re-rendering an identical frame forever.
    if (this.reduced && this._atRest()) { this.raf = null; return; }
    this.raf = requestAnimationFrame(this._loop);
  }
}

const DRAINED = new THREE.Color(0x46464a);

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
const _hsl = { h: 0, s: 0, l: 0 };
// The hearing tone's hue, in sRGB — the colour a recording orb travels to.
const REC_HUE = new THREE.Color(TONE.hearing.color).getHSL(_hsl, THREE.SRGBColorSpace).h;

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
